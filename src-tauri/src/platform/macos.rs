use tauri::ActivationPolicy;

pub fn configure_app(app: &mut tauri::App) {
    app.set_activation_policy(ActivationPolicy::Accessory);
}
