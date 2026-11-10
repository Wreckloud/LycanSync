use serde::Deserialize;
use std::collections::HashMap;
use std::sync::LazyLock;

use crate::detection::normalize_path;

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExecutableRole {
    Game,
    Application,
    Client,
    Launcher,
}

#[derive(Deserialize)]
struct ExecutableRule {
    path: String,
    role: ExecutableRole,
    arguments: Option<String>,
}

#[derive(Deserialize)]
pub struct KnownGame {
    pub id: String,
    name: String,
    name_zh_cn: Option<String>,
    display_name: Option<String>,
    install_keys: Vec<String>,
    executables: Vec<ExecutableRule>,
}

impl KnownGame {
    pub fn has_game_executable(&self) -> bool {
        self.executables
            .iter()
            .any(|rule| rule.role == ExecutableRole::Game)
    }

    pub fn display_name<'a>(&'a self, installed_name: Option<&'a str>) -> &'a str {
        self.display_name
            .as_deref()
            .or(self.name_zh_cn.as_deref())
            .or(installed_name)
            .unwrap_or(&self.name)
    }

    pub fn key(&self) -> String {
        format!("known:{}", self.id)
    }
}

#[derive(Deserialize)]
struct Snapshot {
    schema_version: u32,
    games: Vec<KnownGame>,
    localized_names: HashMap<String, String>,
}

pub struct GameMatch<'a> {
    pub game: &'a KnownGame,
    pub role: ExecutableRole,
}

pub struct GameCatalog {
    games: Vec<KnownGame>,
    by_executable: HashMap<String, Vec<(usize, usize)>>,
    by_install_key: HashMap<String, Option<usize>>,
    localized_names: HashMap<String, String>,
}

impl GameCatalog {
    fn from_json(content: &str) -> Result<Self, String> {
        let snapshot: Snapshot =
            serde_json::from_str(content).map_err(|error| error.to_string())?;
        if snapshot.schema_version != 1 || snapshot.games.is_empty() {
            return Err("游戏规则快照版本无效或内容为空".to_owned());
        }
        let mut catalog = Self {
            games: snapshot.games,
            localized_names: snapshot.localized_names,
            by_executable: HashMap::new(),
            by_install_key: HashMap::new(),
        };
        for (game_index, game) in catalog.games.iter().enumerate() {
            for key in &game.install_keys {
                catalog
                    .by_install_key
                    .entry(key.clone())
                    .and_modify(|index| *index = None)
                    .or_insert(Some(game_index));
            }
            for (rule_index, rule) in game.executables.iter().enumerate() {
                catalog
                    .by_executable
                    .entry(rule.path.rsplit('\\').next().unwrap().to_owned())
                    .or_default()
                    .push((game_index, rule_index));
            }
        }
        Ok(catalog)
    }

    pub fn installed_game(&self, key: &str) -> Option<&KnownGame> {
        let index = self.by_install_key.get(key)?.as_ref()?;
        Some(&self.games[*index])
    }

    pub fn localized_install_name(&self, key: &str) -> Option<&str> {
        self.localized_names.get(key).map(String::as_str)
    }

    pub fn needs_arguments(&self, executable: &str) -> bool {
        self.rules(executable).iter().any(|(game, rule)| {
            let rule = &self.games[*game].executables[*rule];
            rule.arguments.is_some() && path_matches(executable, &rule.path)
        })
    }

    pub fn find(&self, executable: &str, arguments: &[String]) -> Option<GameMatch<'_>> {
        let mut best = None;
        let mut best_score = (0, false, 0);
        let mut ambiguous = false;
        for (game_index, rule_index) in self.rules(executable) {
            let game = &self.games[*game_index];
            let rule = &game.executables[*rule_index];
            if !path_matches(executable, &rule.path) {
                continue;
            }
            if let Some(required) = &rule.arguments {
                let required: Vec<_> = required.split_whitespace().collect();
                // 参数条件按完整参数匹配；读不到参数时不能把共用运行时猜成游戏。
                if required.is_empty()
                    || !arguments.windows(required.len()).any(|values| {
                        values
                            .iter()
                            .map(String::as_str)
                            .eq(required.iter().copied())
                    })
                {
                    continue;
                }
            }
            let score = (
                rule.path.split('\\').count(),
                rule.arguments.is_some(),
                rule.path.len(),
            );
            if best.is_none() || score > best_score {
                best = Some(GameMatch {
                    game,
                    role: rule.role,
                });
                best_score = score;
                ambiguous = false;
            } else if score == best_score
                && best.as_ref().is_some_and(|previous| {
                    previous.game.id != game.id || previous.role != rule.role
                })
            {
                ambiguous = true;
            }
        }
        (!ambiguous).then_some(best).flatten()
    }

    fn rules(&self, executable: &str) -> &[(usize, usize)] {
        self.by_executable
            .get(executable.rsplit('\\').next().unwrap_or(executable))
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }
}

fn path_matches(executable: &str, suffix: &str) -> bool {
    executable == suffix
        || executable
            .strip_suffix(suffix)
            .is_some_and(|prefix| prefix.ends_with('\\'))
}

pub fn bundled() -> &'static GameCatalog {
    static CATALOG: LazyLock<GameCatalog> = LazyLock::new(|| {
        GameCatalog::from_json(include_str!("../resources/games.json"))
            .expect("内置游戏规则快照无效，请重新生成并构建")
    });
    &CATALOG
}

pub fn find(executable: &str, arguments: &[String]) -> Option<GameMatch<'static>> {
    bundled().find(executable, arguments)
}

pub fn mapped_game(executable: &str) -> Option<&'static KnownGame> {
    // 映射已由用户明确选择，不需要也不会保存它的启动参数。
    find(&normalize_path(executable), &[]).map(|matched| matched.game)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_catalog_supports_non_platform_games_and_chinese_names() {
        let matched = find("d:\\standalone\\genshinimpact.exe", &[]).unwrap();
        assert_eq!(matched.game.display_name(None), "原神");
        assert!(find("d:\\standalone\\not-genshinimpact.exe", &[]).is_none());
        let installed = bundled().installed_game("steam:730").unwrap();
        let matched = find("d:\\cs\\win64\\cs2.exe", &[]).unwrap();
        assert_eq!(installed.id, matched.game.id);
        assert_eq!(
            installed.display_name(Some("Counter-Strike 2")),
            "反恐精英2"
        );
    }

    #[test]
    fn shared_runtime_requires_real_arguments_and_complete_tokens() {
        let executable = "c:\\java\\javaw.exe";
        assert!(bundled().needs_arguments(executable));
        assert!(find(executable, &[]).is_none());
        assert!(find(executable, &["net.minecraft.client.main.MainExtra".into()]).is_none());
        let matched = find(executable, &["net.minecraft.client.main.Main".into()]).unwrap();
        assert_eq!(matched.game.display_name(None), "我的世界");
    }

    #[test]
    fn equal_rules_for_different_games_are_not_guessed_and_specific_paths_win() {
        let catalog = GameCatalog::from_json(
            r#"{"schema_version":1,"localized_names":{},"games":[
                {"id":"1","name":"A","install_keys":[],"executables":[{"path":"game.exe","role":"game"}]},
                {"id":"2","name":"B","install_keys":[],"executables":[{"path":"game.exe","role":"game"},
                    {"path":"b\\game.exe","role":"game"}]}
            ]}"#,
        ).unwrap();
        assert!(catalog.find("c:\\game.exe", &[]).is_none());
        assert_eq!(catalog.find("c:\\b\\game.exe", &[]).unwrap().game.id, "2");
        assert!(catalog.find("c:\\ab\\game.exe", &[]).is_none());
    }
}
