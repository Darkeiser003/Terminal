#![no_main]

use github_target::{parse_github_target, Target};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let input = String::from_utf8_lossy(data);
    if let Some(target) = parse_github_target(&input) {
        match target {
            Target::Owner(owner) => {
                assert!(!owner.is_empty());
                assert!(owner.len() <= 39);
                assert!(github_target::is_github_owner(&owner));
            }
            Target::Repo(full_name) => {
                assert_eq!(
                    full_name.full_name,
                    format!("{}/{}", full_name.owner, full_name.name)
                );
                assert!(github_target::is_github_owner(&full_name.owner));
                assert!(github_target::is_github_repo_name(&full_name.name));
            }
        }
    }
});
