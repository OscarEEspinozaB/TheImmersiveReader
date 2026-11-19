//! Read-aloud on Linux with Piper, a local neural text-to-speech engine.
//!
//! WebKitGTK's own speech has no Spanish voice and no word events, so the desktop app
//! synthesizes sentences here and the web layer plays them (src/desktopVoice.js). The
//! engine and the voices are downloaded on request, only from the pinned addresses
//! below, and each file must match its SHA-256 before it is used.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_http::reqwest;
use tokio::fs;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;

const ENGINE_URL: &str =
    "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz";
const ENGINE_SHA256: &str = "a50cb45f355b7af1f6d758c1b360717877ba0a398cc8cbe6d2a7a3a26e225992";
const ENGINE_BYTES: u64 = 26_460_462;
const VOICES_URL: &str =
    "https://huggingface.co/rhasspy/piper-voices/resolve/04ca88f5685ca5253c701af3687e155b113bd512";
const SYNTHESIS_TIMEOUT: Duration = Duration::from_secs(60);
const PROGRESS_STEP: u64 = 512 * 1024;

struct Voice {
    id: &'static str,
    lang: &'static str,
    name: &'static str,
    path: &'static str,
    bytes: u64,
    sha256: &'static str,
}

/// The first voice of each language is its default.
const VOICES: &[Voice] = &[
    Voice {
        id: "en_US-lessac-medium",
        lang: "en-US",
        name: "Lessac",
        path: "en/en_US/lessac/medium",
        bytes: 63_201_294,
        sha256: "5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f",
    },
    Voice {
        id: "en_GB-alba-medium",
        lang: "en-GB",
        name: "Alba",
        path: "en/en_GB/alba/medium",
        bytes: 63_221_984,
        sha256: "1f9da809b6da1ef4190bb5dd6cce4f4af803274539e9cf9e0693085150bac3d7",
    },
    Voice {
        id: "es_MX-claude-high",
        lang: "es-MX",
        name: "Claude",
        path: "es/es_MX/claude/high",
        bytes: 63_122_309,
        sha256: "3ef40a71ea63852cd8ab7e6fa7d2ecdcfa67a0b47c9c48e3f10e02ee02083ea0",
    },
    Voice {
        id: "es_ES-davefx-medium",
        lang: "es-ES",
        name: "Davefx",
        path: "es/es_ES/davefx/medium",
        bytes: 63_221_984,
        sha256: "d2c9224e122321aac3c33343957fff4d0f465226cb74c66b0f520ca3f8c0dd07",
    },
    Voice {
        id: "fr_FR-siwis-medium",
        lang: "fr-FR",
        name: "Siwis",
        path: "fr/fr_FR/siwis/medium",
        bytes: 63_221_984,
        sha256: "b1d946fd68d0347155fa59bce0a018924abbef3c1561181db45ca463d83963ef",
    },
    Voice {
        id: "de_DE-thorsten-medium",
        lang: "de-DE",
        name: "Thorsten",
        path: "de/de_DE/thorsten/medium",
        bytes: 63_221_984,
        sha256: "fd270eb3d1ebf91d763f8a0f949b1b1bebdfefaea18c3aaf8577dd34536e064f",
    },
    Voice {
        id: "it_IT-paola-medium",
        lang: "it-IT",
        name: "Paola",
        path: "it/it_IT/paola/medium",
        bytes: 63_221_984,
        sha256: "f9b8658aa8c01f8280aa88488f6e7643a639b6225a81514c40440a01f6364a20",
    },
    Voice {
        id: "pt_BR-faber-medium",
        lang: "pt-BR",
        name: "Faber",
        path: "pt/pt_BR/faber/medium",
        bytes: 63_221_984,
        sha256: "75e913eb463db0b6ac7ddf68d3e4c9ac19ace36dc3b710a81039b448352b8ffc",
    },
];

struct Running {
    voice: String,
    // Held so the engine is killed with it.
    _child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

/// The running engine (one voice at a time) and the single-install guard.
#[derive(Default)]
pub struct VoiceEngine {
    running: Mutex<Option<Running>>,
    installing: Mutex<()>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceEntry {
    id: &'static str,
    lang: &'static str,
    name: &'static str,
    download_bytes: u64,
    installed: bool,
}

#[derive(Clone, Serialize)]
pub struct InstallProgress {
    done: u64,
    total: u64,
}

fn voice_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(text)?.join("voice"))
}

fn engine_binary(root: &Path) -> PathBuf {
    root.join("engine").join("piper").join("piper")
}

fn model_path(root: &Path, id: &str) -> PathBuf {
    root.join("models").join(format!("{id}.onnx"))
}

fn config_path(root: &Path, id: &str) -> PathBuf {
    root.join("models").join(format!("{id}.onnx.json"))
}

fn is_installed(root: &Path, id: &str) -> bool {
    model_path(root, id).is_file() && config_path(root, id).is_file()
}

fn find_voice(id: &str) -> Result<&'static Voice, String> {
    VOICES
        .iter()
        .find(|voice| voice.id == id)
        .ok_or_else(|| format!("unknown voice {id}"))
}

fn text(err: impl std::fmt::Display) -> String {
    err.to_string()
}

/// The voices this platform can use: none outside Linux.
#[tauri::command]
pub fn voice_catalog(app: AppHandle) -> Result<Vec<VoiceEntry>, String> {
    if !cfg!(target_os = "linux") {
        return Ok(Vec::new());
    }
    let root = voice_root(&app)?;
    let engine_missing = !engine_binary(&root).is_file();
    Ok(VOICES
        .iter()
        .map(|voice| VoiceEntry {
            id: voice.id,
            lang: voice.lang,
            name: voice.name,
            download_bytes: voice.bytes + if engine_missing { ENGINE_BYTES } else { 0 },
            installed: is_installed(&root, voice.id),
        })
        .collect())
}

struct Progress<'a> {
    channel: &'a Channel<InstallProgress>,
    done: u64,
    total: u64,
    reported: u64,
}

impl Progress<'_> {
    fn add(&mut self, bytes: u64) {
        self.done += bytes;
        if self.done - self.reported >= PROGRESS_STEP || self.done == self.total {
            self.reported = self.done;
            let _ = self.channel.send(InstallProgress {
                done: self.done,
                total: self.total,
            });
        }
    }
}

/// Download `url` to `dest`, which appears only once its size and hash are right.
async fn download_verified(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    bytes: u64,
    sha256: &str,
    progress: &mut Progress<'_>,
) -> Result<(), String> {
    let part = dest.with_extension("part");
    let result = async {
        let mut response = client
            .get(url)
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(text)?;
        let mut file = fs::File::create(&part).await.map_err(text)?;
        let mut hash = Sha256::new();
        let mut received = 0;
        while let Some(chunk) = response.chunk().await.map_err(text)? {
            file.write_all(&chunk).await.map_err(text)?;
            hash.update(&chunk);
            received += chunk.len() as u64;
            progress.add(chunk.len() as u64);
        }
        file.flush().await.map_err(text)?;
        let actual: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
        if received != bytes || actual != sha256 {
            return Err(format!("{url} did not match its expected size and hash"));
        }
        fs::rename(&part, dest).await.map_err(text)
    }
    .await;
    if result.is_err() {
        let _ = fs::remove_file(&part).await;
    }
    result
}

async fn install_engine(
    client: &reqwest::Client,
    root: &Path,
    progress: &mut Progress<'_>,
) -> Result<(), String> {
    let archive = root.join("engine.tar.gz");
    download_verified(
        client,
        ENGINE_URL,
        &archive,
        ENGINE_BYTES,
        ENGINE_SHA256,
        progress,
    )
    .await?;
    let unpacking = root.join("engine.unpacking");
    let engine = root.join("engine");
    let target = unpacking.clone();
    let source = archive.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let _ = std::fs::remove_dir_all(&target);
        std::fs::create_dir_all(&target).map_err(text)?;
        let file = std::fs::File::open(source).map_err(text)?;
        tar::Archive::new(flate2::read::GzDecoder::new(file))
            .unpack(&target)
            .map_err(text)
    })
    .await
    .map_err(text)??;
    let _ = fs::remove_dir_all(&engine).await;
    fs::rename(&unpacking, &engine).await.map_err(text)?;
    fs::remove_file(&archive).await.map_err(text)
}

/// This engine rejects the multi-character phoneme keys newer voice files list. It
/// never produces those phonemes, so they are dropped from the installed copy.
fn engine_compatible_config(raw: &[u8]) -> Result<Vec<u8>, String> {
    let mut config: serde_json::Value = serde_json::from_slice(raw).map_err(text)?;
    config
        .get_mut("phoneme_id_map")
        .and_then(|map| map.as_object_mut())
        .ok_or("the voice has no phoneme map")?
        .retain(|phoneme, _| phoneme.chars().count() == 1);
    serde_json::to_vec(&config).map_err(text)
}

/// Install the engine if it is missing, then the voice.
#[tauri::command]
pub async fn voice_install(
    app: AppHandle,
    engine: State<'_, VoiceEngine>,
    voice: String,
    on_progress: Channel<InstallProgress>,
) -> Result<(), String> {
    let voice = find_voice(&voice)?;
    let _guard = engine.installing.lock().await;
    let root = voice_root(&app)?;
    fs::create_dir_all(root.join("models"))
        .await
        .map_err(text)?;
    let needs_engine = !engine_binary(&root).is_file();
    let needs_voice = !is_installed(&root, voice.id);
    let total =
        if needs_engine { ENGINE_BYTES } else { 0 } + if needs_voice { voice.bytes } else { 0 };
    let mut progress = Progress {
        channel: &on_progress,
        done: 0,
        total,
        reported: 0,
    };
    let client = reqwest::Client::new();
    if needs_engine {
        install_engine(&client, &root, &mut progress).await?;
    }
    if needs_voice {
        let base = format!("{VOICES_URL}/{}/{}.onnx", voice.path, voice.id);
        let config = client
            .get(format!("{base}.json"))
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(text)?
            .bytes()
            .await
            .map_err(text)?;
        let config = engine_compatible_config(&config)?;
        download_verified(
            &client,
            &base,
            &model_path(&root, voice.id),
            voice.bytes,
            voice.sha256,
            &mut progress,
        )
        .await?;
        fs::write(config_path(&root, voice.id), config)
            .await
            .map_err(text)?;
    }
    Ok(())
}

fn start_engine(root: &Path, output: &Path, voice: &str) -> Result<Running, String> {
    let mut child = Command::new(engine_binary(root))
        .arg("--model")
        .arg(model_path(root, voice))
        .arg("--output_dir")
        .arg(output)
        .arg("--quiet")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(text)?;
    let stdin = child.stdin.take().ok_or("the engine has no input")?;
    let stdout = child.stdout.take().ok_or("the engine has no output")?;
    Ok(Running {
        voice: voice.to_string(),
        _child: child,
        stdin,
        stdout: BufReader::new(stdout),
    })
}

/// Synthesize one sentence and return it as WAV bytes. The engine stays loaded between
/// sentences, and one that fails is replaced on the next call.
#[tauri::command]
pub async fn voice_speak(
    app: AppHandle,
    engine: State<'_, VoiceEngine>,
    voice: String,
    text: String,
) -> Result<Response, String> {
    let voice = find_voice(&voice)?;
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.is_empty() {
        return Err("nothing to say".into());
    }
    let root = voice_root(&app)?;
    if !engine_binary(&root).is_file() || !is_installed(&root, voice.id) {
        return Err(format!("voice {} is not installed", voice.id));
    }
    let output = app
        .path()
        .app_cache_dir()
        .map_err(self::text)?
        .join("voice-output");
    fs::create_dir_all(&output).await.map_err(self::text)?;

    let mut running = engine.running.lock().await;
    if running.as_ref().map(|r| r.voice.as_str()) != Some(voice.id) {
        *running = None;
        *running = Some(start_engine(&root, &output, voice.id)?);
    }
    let result = synthesize(running.as_mut().expect("engine started above"), &line).await;
    if result.is_err() {
        *running = None;
    }
    let path = result?;
    let wav = fs::read(&path).await.map_err(self::text)?;
    let _ = fs::remove_file(&path).await;
    Ok(Response::new(wav))
}

async fn synthesize(engine: &mut Running, line: &str) -> Result<PathBuf, String> {
    engine
        .stdin
        .write_all(format!("{line}\n").as_bytes())
        .await
        .map_err(text)?;
    engine.stdin.flush().await.map_err(text)?;
    let mut path = String::new();
    let read = tokio::time::timeout(SYNTHESIS_TIMEOUT, engine.stdout.read_line(&mut path))
        .await
        .map_err(|_| "the voice engine timed out".to_string())?
        .map_err(text)?;
    if read == 0 {
        return Err("the voice engine stopped".into());
    }
    Ok(PathBuf::from(path.trim()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn serve_once(body: &'static [u8]) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 1024];
            let _ = stream.read(&mut request);
            let head = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", body.len());
            stream.write_all(head.as_bytes()).unwrap();
            stream.write_all(body).unwrap();
        });
        format!("http://{address}/file")
    }

    fn fetch(url: &str, dest: &Path, bytes: u64, sha256: &str) -> Result<(), String> {
        let channel = Channel::new(|_| Ok(()));
        let mut progress = Progress {
            channel: &channel,
            done: 0,
            total: bytes,
            reported: 0,
        };
        let client = reqwest::Client::new();
        tauri::async_runtime::block_on(download_verified(
            &client,
            url,
            dest,
            bytes,
            sha256,
            &mut progress,
        ))
    }

    fn temp_file(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tir-voice-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    const HELLO_SHA256: &str = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

    #[test]
    fn keeps_a_download_that_matches_its_hash() {
        let dest = temp_file("good.bin");
        fetch(&serve_once(b"hello"), &dest, 5, HELLO_SHA256).unwrap();
        assert_eq!(std::fs::read(dest).unwrap(), b"hello");
    }

    #[test]
    fn discards_a_download_with_the_wrong_hash() {
        let dest = temp_file("bad.bin");
        assert!(fetch(&serve_once(b"hellO"), &dest, 5, HELLO_SHA256).is_err());
        assert!(!dest.exists());
        assert!(!dest.with_extension("part").exists());
    }

    #[test]
    fn drops_only_the_phonemes_the_engine_rejects() {
        let raw = r#"{"phoneme_id_map":{"a":[1],"aI":[2],"ɑ":[3]},"keep":true}"#.as_bytes();
        let config: serde_json::Value =
            serde_json::from_slice(&engine_compatible_config(raw).unwrap()).unwrap();
        let map = config["phoneme_id_map"].as_object().unwrap();
        assert_eq!(map.len(), 2);
        assert!(map.contains_key("a") && !map.contains_key("aI"));
        assert_eq!(config["keep"], true);
    }
}
