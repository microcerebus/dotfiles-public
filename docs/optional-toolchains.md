# Optional toolchains - on demand, never global

Everything disabled by default (Go, Rust, Java, Android, k8s, Terraform, cloud
CLIs, heavy React Native) is enabled *per project* via devShells + direnv:

1. `cd` into the project; `dev-doctor` reports detected markers.
2. `dev-enable <template>` drops a flake devShell; `direnv allow` activates it.
3. Leave the directory → tools are gone. Nothing global changed.

Templates live in `~/dotfiles/templates/devshells/`. Missing templates
(kubernetes, aws, go, rust, react-native-ios) are created on first need - ask
Claude Code to draft one, review, commit.

React Native: iOS-only and minimal - Xcode from the App Store plus a devshell
with node/watchman; no Android SDK, ever, unless explicitly requested.
