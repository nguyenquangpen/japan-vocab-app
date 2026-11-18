mod hub;

use tauri_plugin_sql::{Migration, MigrationKind};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![
        Migration {
            version: 1,
            description: "create_tables",
            sql: include_str!("../migrations/0001_init.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "card_learning_steps",
            sql: include_str!("../migrations/0002_card_learning_steps.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "quiz_results",
            sql: include_str!("../migrations/0003_quiz_results.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "meaning_detail",
            sql: include_str!("../migrations/0004_meaning_detail.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "practice_items",
            sql: include_str!("../migrations/0005_practice_items.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "hub_outbox",
            sql: include_str!("../migrations/0006_hub_outbox.sql"),
            kind: MigrationKind::Up,
        },
    ];

    tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:vocab.db", migrations)
                .build(),
        )
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![hub::hub_post])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
