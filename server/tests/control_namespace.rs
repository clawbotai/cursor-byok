use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use cursor_server::{
    control::{web_router, ControlService},
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
        panic!("control requests must not invoke a model")
    }
}

#[tokio::test]
async fn frontend_and_management_api_use_the_new_namespace() {
    let store = Store::connect("sqlite::memory:").await.unwrap();
    let runtime = PluginRuntime::managed().unwrap();
    let clients = NetworkClients::new(store.clone());
    let registry =
        PluginRegistry::managed(runtime.clone(), "1.1.2".into(), clients.clone()).unwrap();
    let service =
        ControlService::new(store, Arc::new(NoInference), runtime, registry, clients).unwrap();
    let assets = tempfile::tempdir().unwrap();
    std::fs::write(assets.path().join("index.html"), "control frontend").unwrap();
    let router = web_router(service, assets.path());

    for (path, status) in [
        ("/__call-details__/", StatusCode::OK),
        ("/__call-details__/api/models", StatusCode::OK),
        ("/__byok-api__/", StatusCode::NOT_FOUND),
        ("/__byok-api__/api/models", StatusCode::NOT_FOUND),
    ] {
        let response = router
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), status, "{path}");
        if path == "/__call-details__/" {
            let body = to_bytes(response.into_body(), 1_024).await.unwrap();
            assert_eq!(body.as_ref(), b"control frontend");
        }
    }
}
