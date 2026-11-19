//! Desktop shell around the same web build the browser and the Android APK run.

use tauri::Manager;

mod files;
mod voice;

pub fn run() {
    #[cfg(target_os = "linux")]
    files::restart_appimage_with_absolute_args();

    tauri::Builder::default()
        // Must stay first: a second launch hands over its files and exits here.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            files::offer_from_second_launch(app, argv, cwd);
        }))
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .manage(voice::VoiceEngine::default())
        .manage(files::FileInbox::default())
        .setup(|app| {
            files::offer_startup_args(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| files::on_window_event(window.app_handle(), event))
        .invoke_handler(tauri::generate_handler![
            voice::voice_catalog,
            voice::voice_install,
            voice::voice_speak,
            files::files_take,
            files::file_read
        ])
        .run(tauri::generate_context!())
        .expect("failed to start The Immersive Reader");
}
