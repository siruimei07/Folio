//! Compile the APIs selected in versioning.md §18 without exercising M2 features.

use std::io::Cursor;
use std::time::{Duration, Instant};

#[test]
fn m2_dependency_apis_compile() {
    // The closure is type-checked but never called: no parsing, I/O or HTTP request runs.
    let _: fn() -> Result<(), Box<dyn std::error::Error>> = || {
        let deadline = Instant::now() + Duration::from_secs(1);
        let diff = similar::TextDiff::configure()
            .algorithm(similar::Algorithm::Patience)
            .deadline(deadline)
            .diff_lines("before\n", "after\n");
        let mut inline = similar::InlineChangeOptions::new();
        inline
            .algorithm(similar::Algorithm::Patience)
            .mode(similar::InlineChangeMode::Chars);
        for op in diff.ops() {
            let _ = diff.iter_inline_changes_with_options_deadline(op, inline, Some(deadline));
        }

        let mut archive = zip::ZipArchive::new(Cursor::new(Vec::<u8>::new()))?;
        let _ = archive.by_name("word/document.xml")?;
        let mut xml = quick_xml::Reader::from_reader(Cursor::new(b"<document/>"));
        let _ = xml.read_event_into(&mut Vec::new())?;
        let _ = encoding_rs::GB18030.decode_without_bom_handling(b"");
        let _ = encoding_rs::UTF_16LE.decode_without_bom_handling(b"");
        let _ = encoding_rs::UTF_16BE.decode_without_bom_handling(b"");

        let mut encoder = zstd::stream::Encoder::new(Vec::<u8>::new(), 3)?;
        encoder.window_log(23)?;
        encoder.set_pledged_src_size(Some(0))?;
        encoder.include_contentsize(true)?;
        let mut decoder =
            zstd::stream::read::Decoder::new(Cursor::new(encoder.finish()?))?.single_frame();
        decoder.window_log_max(23)?;
        decoder.finish_frame()?;
        let _ = decoder.finish();

        let _agent = ureq::Agent::config_builder()
            .https_only(true)
            .max_redirects(0)
            .timeout_connect(Some(Duration::from_secs(10)))
            .timeout_global(Some(Duration::from_secs(30)))
            .tls_config(
                ureq::tls::TlsConfig::builder()
                    .provider(ureq::tls::TlsProvider::Rustls)
                    .root_certs(ureq::tls::RootCerts::PlatformVerifier)
                    .build(),
            )
            .build()
            .new_agent();

        #[cfg(windows)]
        {
            let _ = windows_sys::Win32::Security::Credentials::CredReadW;
            let _ = windows_sys::Win32::System::Registry::RegGetValueW;
        }
        Ok(())
    };
}
