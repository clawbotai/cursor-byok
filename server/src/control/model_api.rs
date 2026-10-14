//! OpenAI Chat Completions entry point over the existing provider pipeline.
use super::ControlService;
use crate::{
    model::{
        ContentPart, ModelInvocation, ModelRequest, ModelSpec, ProjectedContent, ProjectedMessage,
        PromptSpec, ProviderReplayState, Role, ToolCallContent, ToolDefinition, ToolResultContent,
    },
    provider::{FinishReason, ModelEvent},
    Error, Result,
};
use axum::{
    extract::State,
    http::StatusCode,
    response::{sse::Event, IntoResponse, Response, Sse},
    Json,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashMap, convert::Infallible};
use tokio_util::sync::CancellationToken;

#[derive(Deserialize)]
pub(super) struct ChatRequest {
    model: String,
    messages: Vec<Value>,
    #[serde(default)]
    tools: Vec<Value>,
    #[serde(default)]
    stream: bool,
    #[serde(alias = "max_completion_tokens")]
    max_tokens: Option<u64>,
}

pub(super) async fn list(State(service): State<ControlService>) -> Json<Value> {
    let mut data = Vec::new();
    for plugin in service.plugins().await {
        for provider in plugin.providers.into_iter().filter(|p| p.configured) {
            for model in provider.models.into_iter().filter(|m| m.enabled) {
                data.push(json!({"id":model.id,"object":"model","owned_by":model.provider_id,"upstream_id":model.model_id,"name":model.display_name,"images":model.images,"max_output_tokens":model.max_output_tokens}));
            }
        }
    }
    Json(json!({"object":"list","data":data}))
}

fn string<'a>(value: &'a Value, field: &str) -> Result<&'a str> {
    value[field]
        .as_str()
        .ok_or_else(|| Error::Protocol(format!("missing string field: {field}")))
}
fn parts(content: &Value) -> Result<Vec<ContentPart>> {
    if let Some(text) = content.as_str() {
        return Ok(vec![ContentPart::Text { text: text.into() }]);
    }
    if content.is_null() {
        return Ok(Vec::new());
    }
    content
        .as_array()
        .ok_or_else(|| Error::Protocol("content must be text or an array".into()))?
        .iter()
        .map(|part| match string(part, "type")? {
            "text" => Ok(ContentPart::Text {
                text: string(part, "text")?.into(),
            }),
            "image_url" => {
                let url = string(&part["image_url"], "url")?;
                let (mime, data) = url
                    .strip_prefix("data:")
                    .and_then(|v| v.split_once(";base64,"))
                    .ok_or_else(|| {
                        Error::Protocol("image_url must contain inline base64 data".into())
                    })?;
                Ok(ContentPart::Image {
                    mime_type: mime.into(),
                    data: STANDARD
                        .decode(data)
                        .map_err(|e| Error::Protocol(e.to_string()))?,
                })
            }
            other => Err(Error::Protocol(format!(
                "unsupported content type: {other}"
            ))),
        })
        .collect()
}
fn text(content: &Value) -> Result<String> {
    Ok(parts(content)?
        .into_iter()
        .filter_map(|p| match p {
            ContentPart::Text { text } => Some(text),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n"))
}

fn invocation(input: &ChatRequest, selected: String) -> Result<ModelInvocation> {
    let id = uuid::Uuid::new_v4().to_string();
    let mut instructions = Vec::new();
    let mut history = Vec::new();
    let mut names = HashMap::new();
    for (index, message) in input.messages.iter().enumerate() {
        let (role, content) = match string(message, "role")? {
            "system" | "developer" => {
                instructions.push(text(&message["content"])?);
                continue;
            }
            "user" => (
                Role::User,
                ProjectedContent::Parts(parts(&message["content"])?),
            ),
            "assistant" => {
                let mut calls = Vec::new();
                if let Some(raw) = message["tool_calls"].as_array() {
                    for (index, call) in raw.iter().enumerate() {
                        let call_id = string(call, "id")?.to_owned();
                        let name = string(&call["function"], "name")?.to_owned();
                        names.insert(call_id.clone(), name.clone());
                        calls.push(ToolCallContent {
                            index,
                            call_id,
                            name,
                            arguments: serde_json::from_str(string(
                                &call["function"],
                                "arguments",
                            )?)?,
                        });
                    }
                }
                let replay_state = message["reasoning_details"]
                    .as_array()
                    .and_then(|details| details.iter().find(|d| d["type"] == "reasoning.encrypted"))
                    .map(|detail| -> Result<_> {
                        let value: Value = serde_json::from_str(string(detail, "data")?)?;
                        Ok(ProviderReplayState {
                            provider_kind: string(&value, "provider_kind")?.into(),
                            value: value["value"].clone(),
                        })
                    })
                    .transpose()?;
                (
                    Role::Assistant,
                    ProjectedContent::Assistant {
                        text: text(&message["content"])?,
                        thinking: message["reasoning_content"].as_str().unwrap_or("").into(),
                        replay_state,
                        calls,
                    },
                )
            }
            "tool" => {
                let call_id = string(message, "tool_call_id")?.to_owned();
                let name = names
                    .get(&call_id)
                    .ok_or_else(|| Error::Protocol(format!("unknown tool_call_id: {call_id}")))?
                    .clone();
                (
                    Role::Tool,
                    ProjectedContent::ToolResult(ToolResultContent {
                        call_id,
                        name,
                        content: text(&message["content"])?,
                        is_error: false,
                        image: None,
                        provider_parts: parts(&message["content"])?,
                    }),
                )
            }
            other => return Err(Error::Protocol(format!("unsupported role: {other}"))),
        };
        history.push(ProjectedMessage {
            message_id: format!("{id}-{index}"),
            role,
            content,
        });
    }
    let tools = input
        .tools
        .iter()
        .map(|tool| {
            Ok(ToolDefinition {
                name: string(&tool["function"], "name")?.into(),
                description: tool["function"]["description"]
                    .as_str()
                    .unwrap_or("")
                    .into(),
                parameters: tool["function"]["parameters"].clone(),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let mut model = ModelSpec::new(selected);
    model.max_output_tokens = input.max_tokens;
    Ok(ModelInvocation {
        call_id: id.clone(),
        run_id: id.clone(),
        conversation_id: id,
        provider_call_index: 0,
        request: ModelRequest {
            prompt: PromptSpec {
                instructions: instructions.join("\n\n"),
                tools,
            },
            model,
            history,
        },
    })
}

#[derive(Default)]
struct Output {
    text: String,
    thinking: String,
    calls: Vec<Value>,
    replay: Option<ProviderReplayState>,
    usage: Value,
    finish: &'static str,
}
impl Output {
    fn event(&mut self, event: ModelEvent) -> Option<Value> {
        match event {
            ModelEvent::TextDelta(text) => {
                self.text.push_str(&text);
                Some(json!({"content":text}))
            }
            ModelEvent::ThinkingDelta(text) => {
                self.thinking.push_str(&text);
                Some(json!({"reasoning_content":text}))
            }
            ModelEvent::ToolCallStart {
                index,
                call_id,
                name,
            } => {
                self.calls.push(
                    json!({"id":call_id,"type":"function","function":{"name":name,"arguments":""}}),
                );
                Some(
                    json!({"tool_calls":[{"index":index,"id":call_id,"type":"function","function":{"name":name,"arguments":""}}]}),
                )
            }
            ModelEvent::ToolCallArgumentsDelta { index, delta } => {
                let arguments = self.calls[index]["function"]["arguments"]
                    .as_str()
                    .expect("tool arguments are accumulated as text")
                    .to_owned()
                    + &delta;
                self.calls[index]["function"]["arguments"] = json!(arguments);
                Some(json!({"tool_calls":[{"index":index,"function":{"arguments":delta}}]}))
            }
            ModelEvent::ProviderReplayState(state) => {
                self.replay = Some(state);
                Some(json!({"reasoning_details":self.details()}))
            }
            ModelEvent::Usage(usage) => {
                self.usage = json!({"prompt_tokens":usage.input_tokens,"completion_tokens":usage.output_tokens,"total_tokens":usage.total_tokens,"prompt_tokens_details":{"cached_tokens":usage.cache_read_tokens},"completion_tokens_details":{"reasoning_tokens":usage.reasoning_tokens}});
                None
            }
            ModelEvent::Done(reason) => {
                self.finish = match reason {
                    FinishReason::Stop => "stop",
                    FinishReason::Length => "length",
                    FinishReason::ToolUse => "tool_calls",
                };
                None
            }
            _ => None,
        }
    }
    fn details(&self) -> Vec<Value> {
        match &self.replay {
            Some(state)=>self.calls.iter().map(|call|json!({"type":"reasoning.encrypted","id":call["id"],"data":serde_json::to_string(state).expect("replay state is JSON"),"format":"cursor-byok"})).collect(),
            None=>Vec::new(),
        }
    }
}
fn error_response(error: Error) -> Response {
    let message = error.to_string();
    let status = match &error {
        Error::Protocol(_) | Error::Json(_) => StatusCode::BAD_REQUEST,
        Error::RunNotFound(_) => StatusCode::NOT_FOUND,
        _ if message.contains("HTTP 429") => StatusCode::TOO_MANY_REQUESTS,
        _ => StatusCode::BAD_GATEWAY,
    };
    (
        status,
        Json(json!({"error":{"message":message,"type":"provider_error"}})),
    )
        .into_response()
}

pub(super) async fn chat(
    State(service): State<ControlService>,
    Json(input): Json<ChatRequest>,
) -> Response {
    let mut matches = Vec::new();
    for plugin in service.plugins().await {
        for provider in plugin.providers.into_iter().filter(|p| p.configured) {
            matches.extend(
                provider
                    .models
                    .into_iter()
                    .filter(|m| m.enabled && (m.id == input.model || m.model_id == input.model)),
            );
        }
    }
    if matches.len() != 1 {
        return error_response(Error::RunNotFound(format!(
            "enabled model {} (matches: {})",
            input.model,
            matches.len()
        )));
    }
    let request = match invocation(&input, matches.remove(0).id) {
        Ok(request) => request,
        Err(error) => return error_response(error),
    };
    let id = format!("chatcmpl-{}", request.call_id);
    let model = input.model.clone();
    let created = chrono::Utc::now().timestamp();
    let mut upstream = service.inference(request, CancellationToken::new());
    let mut prefix = Vec::new();
    // Return an HTTP error before committing SSE headers when the provider rejects the request.
    while let Some(event) = upstream.next().await {
        match event {
            Ok(event) => {
                let valid = crate::provider::is_valid_response_event(&event);
                prefix.push(event);
                if valid {
                    break;
                }
            }
            Err(error) => return error_response(error),
        }
    }
    let mut output = Output::default();
    if !input.stream {
        for event in prefix {
            output.event(event);
        }
        while let Some(event) = upstream.next().await {
            match event {
                Ok(event) => {
                    output.event(event);
                }
                Err(error) => return error_response(error),
            }
        }
        if output.finish.is_empty() {
            return error_response(Error::Provider(
                "model stream ended without completion".into(),
            ));
        }
        return Json(json!({"id":id,"object":"chat.completion","created":created,"model":model,"choices":[{"index":0,"message":{"role":"assistant","content":output.text,"reasoning_content":output.thinking,"tool_calls":output.calls,"reasoning_details":output.details()},"finish_reason":output.finish}],"usage":output.usage})).into_response();
    }
    let stream = async_stream::stream! {
        let mut events=futures_util::stream::iter(prefix.into_iter().map(Ok)).chain(upstream);
        while let Some(event)=events.next().await {
            match event {
                Ok(event)=>{
                    if let Some(delta)=output.event(event) {
                        yield Ok::<_,Infallible>(Event::default().data(json!({"id":id,"object":"chat.completion.chunk","created":created,"model":model,"choices":[{"index":0,"delta":delta,"finish_reason":null}]}).to_string()));
                    }
                }
                Err(error)=>{yield Ok(Event::default().data(json!({"error":{"message":error.to_string(),"type":"provider_error"}}).to_string()));return;}
            }
        }
        if output.finish.is_empty() {
            yield Ok(Event::default().data(json!({"error":{"message":"model stream ended without completion","type":"provider_error"}}).to_string()));
        } else {
            yield Ok(Event::default().data(json!({"id":id,"object":"chat.completion.chunk","created":created,"model":model,"choices":[{"index":0,"delta":{},"finish_reason":output.finish}],"usage":output.usage}).to_string()));
            yield Ok(Event::default().data("[DONE]"));
        }
    };
    Sse::new(stream).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn chat_request_preserves_tools_images_and_opaque_replay() {
        let input:ChatRequest=serde_json::from_value(json!({"model":"gemini-test","messages":[{"role":"system","content":"system"},{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,aGk="}}]},{"role":"assistant","content":"read","tool_calls":[{"id":"call1","type":"function","function":{"name":"read","arguments":"{\"path\":\"README.md\"}"}}],"reasoning_details":[{"type":"reasoning.encrypted","id":"call1","data":"{\"provider_kind\":\"antigravity\",\"value\":{\"thoughtSignature\":\"signature\"}}"}]},{"role":"tool","tool_call_id":"call1","content":"result"}],"tools":[{"type":"function","function":{"name":"read","parameters":{"type":"object"}}}],"max_tokens":1024})).unwrap();
        let request = invocation(&input, "plugin:model".into()).unwrap().request;
        assert_eq!(request.prompt.instructions, "system");
        assert_eq!(request.prompt.tools[0].name, "read");
        assert_eq!(request.model.max_output_tokens, Some(1024));
        assert!(
            matches!(&request.history[0].content,ProjectedContent::Parts(p) if matches!(&p[0],ContentPart::Image{data,..} if data==b"hi"))
        );
        assert!(
            matches!(&request.history[1].content,ProjectedContent::Assistant{replay_state:Some(s),..} if s.value["thoughtSignature"]=="signature")
        );
        assert!(
            matches!(&request.history[2].content,ProjectedContent::ToolResult(r) if r.name=="read"&&r.call_id=="call1")
        );
    }
    #[test]
    fn unknown_tool_result_is_rejected() {
        let input:ChatRequest=serde_json::from_value(json!({"model":"x","messages":[{"role":"tool","tool_call_id":"missing","content":"result"}]})).unwrap();
        assert!(invocation(&input, "x".into()).is_err());
    }
    #[test]
    fn encrypted_replay_survives_openai_tool_round() {
        let mut output = Output::default();
        output.event(ModelEvent::ToolCallStart {
            index: 0,
            call_id: "call1".into(),
            name: "read".into(),
        });
        output.event(ModelEvent::ToolCallArgumentsDelta {
            index: 0,
            delta: "{}".into(),
        });
        output.event(ModelEvent::ProviderReplayState(ProviderReplayState {
            provider_kind: "antigravity".into(),
            value: json!({"thoughtSignature":"signature"}),
        }));
        let details = output.details();
        assert_eq!(details[0]["type"], "reasoning.encrypted");
        let input:ChatRequest=serde_json::from_value(json!({"model":"x","messages":[{"role":"assistant","content":"","tool_calls":output.calls,"reasoning_details":details}]})).unwrap();
        let request = invocation(&input, "x".into()).unwrap().request;
        assert!(
            matches!(&request.history[0].content,ProjectedContent::Assistant{replay_state:Some(s),..} if s.value["thoughtSignature"]=="signature")
        );
    }
}
