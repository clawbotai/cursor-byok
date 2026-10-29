//! Reads the current DuMate session from its fixed macOS user-data directory.
use crate::{Error, Result};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LocalImportSource {
    DuMate,
}

/// 凭证只进入插件的导入解析器，不返回 HTTP 调用方或写入临时文件。
pub(super) async fn files(source: LocalImportSource) -> Result<serde_json::Value> {
    match source {
        LocalImportSource::DuMate => {
            #[cfg(target_os = "macos")]
            {
                let home = dirs::home_dir()
                    .ok_or_else(|| Error::Config("无法读取当前 Mac 用户目录".into()))?;
                let credential =
                    read_dumate(&home.join("Library/Application Support/qianfan-desktop-app"))
                        .await?;
                Ok(serde_json::json!([{
                    "name": "dumate-local.json",
                    "content": serde_json::to_string(&credential)?,
                }]))
            }
            #[cfg(not(target_os = "macos"))]
            Err(Error::Config(
                "请在安装 DuMate 的 Mac 上添加本机账号".into(),
            ))
        }
    }
}

#[cfg(any(target_os = "macos", test))]
use std::path::Path;

#[cfg(any(target_os = "macos", test))]
async fn read_dumate(directory: &Path) -> Result<serde_json::Value> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Auth {
        active_provider_type: String,
        enterprise_api_base_url: Option<String>,
        vpc_svc_url: Option<String>,
        cookies: String,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Cookie {
        name: String,
        value: String,
        domain: String,
        expiration_date: Option<f64>,
    }

    let invalid = || Error::Config("DuMate 登录信息无法读取，请在 DuMate 中重新登录后重试".into());
    let raw = tokio::fs::read(directory.join("auth.json"))
        .await
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                Error::Config(
                    "未找到 DuMate 登录信息，请先打开 DuMate 并登录企业账号，然后重试".into(),
                )
            } else {
                Error::Io(error)
            }
        })?;
    let auth: Auth = serde_json::from_slice(&raw).map_err(|_| invalid())?;
    if auth.active_provider_type != "enterprise" {
        return Err(Error::Config(
            "请先在 DuMate 中登录企业账号，然后重试".into(),
        ));
    }
    if auth.vpc_svc_url.is_some_and(|value| !value.is_empty()) {
        return Err(Error::Config("当前暂不支持 DuMate 私有化账号".into()));
    }
    let api_base_url = auth.enterprise_api_base_url.ok_or_else(invalid)?;
    let url = url::Url::parse(&api_base_url).map_err(|_| invalid())?;
    let hostname = url.host_str().ok_or_else(invalid)?;
    let key = tokio::fs::read(directory.join(".cookie-key"))
        .await
        .map_err(|_| invalid())?;
    let blob = STANDARD.decode(auth.cookies).map_err(|_| invalid())?;
    if blob.len() < 28 {
        return Err(invalid());
    }
    // DuMate 的 AES-GCM 布局为 nonce(12) + tag(16) + ciphertext。
    // ring 接受 ciphertext + tag，按该布局重排后认证解密。
    let cipher = LessSafeKey::new(UnboundKey::new(&AES_256_GCM, &key).map_err(|_| invalid())?);
    let mut nonce = [0_u8; 12];
    nonce.copy_from_slice(&blob[..12]);
    let mut payload = blob[28..].to_vec();
    payload.extend_from_slice(&blob[12..28]);
    let plaintext = cipher
        .open_in_place(
            Nonce::assume_unique_for_key(nonce),
            Aad::empty(),
            &mut payload,
        )
        .map_err(|_| invalid())?;
    let cookies: Vec<Cookie> = serde_json::from_slice(plaintext).map_err(|_| invalid())?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock is after Unix epoch")
        .as_secs_f64();
    let session = cookies
        .into_iter()
        .find(|cookie| {
            let domain = cookie.domain.trim_start_matches('.');
            cookie.name == "dumate_enterprise_sessionid"
                && !cookie.value.is_empty()
                && (hostname == domain || hostname.ends_with(&format!(".{domain}")))
                && cookie
                    .expiration_date
                    .is_none_or(|at| at == -1.0 || at > now)
        })
        .ok_or_else(|| {
            Error::Config("DuMate 当前账号未登录或会话已过期，请在 DuMate 中重新登录后重试".into())
        })?;
    Ok(serde_json::json!({ "apiBaseUrl": api_base_url, "sessionId": session.value }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
    use serde_json::json;

    #[cfg(target_os = "macos")]
    #[tokio::test]
    #[ignore = "requires a signed-in DuMate account on the current Mac"]
    async fn current_mac_session_is_readable_and_can_list_remote_models() {
        let files = files(LocalImportSource::DuMate).await.unwrap();
        let credential: serde_json::Value =
            serde_json::from_str(files[0]["content"].as_str().unwrap()).unwrap();
        let origin = credential["apiBaseUrl"].as_str().unwrap();
        assert_eq!(origin, "https://zhongzhi.dumate.cn");
        let client = reqwest::Client::new();
        let cookie = format!(
            "dumate_enterprise_sessionid={}",
            credential["sessionId"].as_str().unwrap()
        );
        let user = client
            .get(format!("{origin}/api/dumate-enterprise/app/v1/user"))
            .header("cookie", &cookie)
            .send()
            .await
            .unwrap();
        assert!(user.status().is_success());
        let models = client
            .post(format!(
                "{origin}/api/dumate-enterprise/app/v1/model/list-all"
            ))
            .header("cookie", cookie)
            .json(&json!({}))
            .send()
            .await
            .unwrap();
        assert!(models.status().is_success());
        let body: serde_json::Value = models.json().await.unwrap();
        assert!(!body["items"].as_array().unwrap().is_empty());
    }

    fn fixture(cookies: serde_json::Value, overrides: serde_json::Value) -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        let key = [42_u8; 32];
        let nonce = [24_u8; 12];
        let mut encrypted = serde_json::to_vec(&cookies).unwrap();
        let cipher = LessSafeKey::new(UnboundKey::new(&AES_256_GCM, &key).unwrap());
        let tag = cipher
            .seal_in_place_separate_tag(
                Nonce::assume_unique_for_key(nonce),
                Aad::empty(),
                &mut encrypted,
            )
            .unwrap();
        let blob = [nonce.as_slice(), tag.as_ref(), encrypted.as_slice()].concat();
        let mut auth = json!({
            "activeProviderType":"enterprise",
            "enterpriseApiBaseUrl":"https://zhongzhi.dumate.cn",
            "cookies":STANDARD.encode(blob),
        });
        for (key, value) in overrides.as_object().unwrap() {
            auth[key] = value.clone();
        }
        std::fs::write(
            root.path().join("auth.json"),
            serde_json::to_vec(&auth).unwrap(),
        )
        .unwrap();
        std::fs::write(root.path().join(".cookie-key"), key).unwrap();
        root
    }

    fn cookies() -> serde_json::Value {
        json!([
            {"name":"dumate_enterprise_sessionid","value":"another-account","domain":"other.dumate.cn"},
            {"name":"other-cookie","value":"do-not-import","domain":".dumate.cn"},
            {"name":"dumate_enterprise_sessionid","value":"current-session","domain":"zhongzhi.dumate.cn","expirationDate":4070908800.0}
        ])
    }

    #[tokio::test]
    async fn imports_only_current_tenant_session_without_writing_source_files() {
        let root = fixture(cookies(), json!({}));
        let before = std::fs::read(root.path().join("auth.json")).unwrap();
        let result = read_dumate(root.path()).await.unwrap();
        assert_eq!(
            result,
            json!({"apiBaseUrl":"https://zhongzhi.dumate.cn","sessionId":"current-session"})
        );
        assert_eq!(
            std::fs::read(root.path().join("auth.json")).unwrap(),
            before
        );
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 2);
    }

    #[tokio::test]
    async fn missing_login_explains_how_to_continue() {
        let root = tempfile::tempdir().unwrap();
        let error = read_dumate(root.path()).await.unwrap_err().to_string();
        assert!(error.contains("请先打开 DuMate"), "{error}");
    }

    #[tokio::test]
    async fn personal_and_private_instances_are_rejected_explicitly() {
        for overrides in [
            json!({"activeProviderType":"bce"}),
            json!({"vpcSvcUrl":"https://private.invalid"}),
        ] {
            let root = fixture(cookies(), overrides);
            let error = read_dumate(root.path()).await.unwrap_err().to_string();
            assert!(
                error.contains("企业账号") || error.contains("私有化"),
                "{error}"
            );
        }
    }

    #[tokio::test]
    async fn expired_and_foreign_sessions_ask_user_to_log_in_again() {
        for cookies in [
            json!([]),
            json!([{"name":"dumate_enterprise_sessionid","value":"expired-secret","domain":"zhongzhi.dumate.cn","expirationDate":1}]),
        ] {
            let root = fixture(cookies, json!({}));
            let error = read_dumate(root.path()).await.unwrap_err().to_string();
            assert!(error.contains("重新登录"), "{error}");
            assert!(!error.contains("expired-secret"));
        }
    }

    #[tokio::test]
    async fn corrupted_key_and_encrypted_store_fail_without_exposing_secrets() {
        for key in [vec![0_u8; 32], vec![0_u8; 3]] {
            let root = fixture(cookies(), json!({}));
            std::fs::write(root.path().join(".cookie-key"), key).unwrap();
            let error = read_dumate(root.path()).await.unwrap_err().to_string();
            assert!(error.contains("重新登录"), "{error}");
            assert!(!error.contains("current-session"));
        }
    }

    #[tokio::test]
    async fn encrypted_payload_must_include_nonce_and_tag() {
        let root = fixture(cookies(), json!({"cookies":"YWJj"}));
        let error = read_dumate(root.path()).await.unwrap_err().to_string();
        assert!(error.contains("重新登录"), "{error}");
    }
}
