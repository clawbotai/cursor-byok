use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use cursor_server::{
    control::{api_router, ControlService},
    model::ModelInvocation,
    network::NetworkClients,
    plugin::{PluginRegistry, PluginRuntime},
    provider::{Provider, ProviderStream},
    store::Store,
};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;

struct NoInference;
impl Provider for NoInference {
    fn stream(&self, _request: ModelInvocation, _cancel: CancellationToken) -> ProviderStream {
        panic!("listing models must not call an upstream model")
    }
}
#[tokio::test]
async fn standard_model_catalog_is_available_without_exposing_credentials() {
    let store = Store::connect("sqlite::memory:").await.unwrap();
    let runtime = PluginRuntime::managed().unwrap();
    let clients = NetworkClients::new(store.clone());
    let registry =
        PluginRegistry::managed(runtime.clone(), "1.0.1".into(), clients.clone()).unwrap();
    let service = ControlService::new(
        store.clone(),
        Arc::new(NoInference),
        runtime,
        registry,
        clients,
    )
    .unwrap();
    let response = api_router(service)
        .oneshot(
            Request::builder()
                .uri("/v1/models")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["object"], "list");
    assert!(value["data"].is_array());
    let text = String::from_utf8(body.to_vec()).unwrap();
    assert!(!text.contains("accessToken"));
    assert!(!text.contains("refreshToken"));
}
