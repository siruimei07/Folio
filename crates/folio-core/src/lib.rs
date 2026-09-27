//! Folio core: library model, catalog, history and sync.
//!
//! This crate must stay free of Tauri, UI and IPC types so the shell can change and a future
//! Swift app can reuse it (ADR-0001). It reaches the OS only through adapter traits.

/// A `String` newtype whose every value passed `$check`; deserializing runs the same check.
macro_rules! validated_string {
    ($(#[$doc:meta])* $name:ident, $error:ty, $check:expr) => {
        $(#[$doc])*
        #[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize)]
        #[serde(try_from = "String", into = "String")]
        pub struct $name(String);

        impl $name {
            pub fn parse(text: &str) -> Result<Self, $error> {
                let check: fn(&str) -> Result<(), $error> = $check;
                check(text)?;
                Ok(Self(text.to_owned()))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl TryFrom<String> for $name {
            type Error = $error;

            fn try_from(text: String) -> Result<Self, $error> {
                let check: fn(&str) -> Result<(), $error> = $check;
                check(&text)?;
                Ok(Self(text))
            }
        }

        impl From<$name> for String {
            fn from(value: $name) -> Self {
                value.0
            }
        }

        impl std::borrow::Borrow<str> for $name {
            fn borrow(&self) -> &str {
                &self.0
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl std::fmt::Debug for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                std::fmt::Debug::fmt(&self.0, f)
            }
        }
    };
}

/// Lower-case hexadecimal digits only.
pub(crate) fn is_lower_hex(text: &str) -> bool {
    text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub mod catalog;
mod files;
pub mod hash;
pub mod meta;
pub mod paths;
pub mod search;
#[cfg(test)]
mod test_support;

/// Version of the core crate, reported to the UI for diagnostics.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
