use super::*;
#[test]
fn rejects_unowned_windows_and_unknown_modes() {
    assert!(validate_request("main", "window").is_ok());
    assert!(validate_request("tray", "content").is_ok());
    assert!(validate_request("../../other", "window").is_err());
    assert!(validate_request("main", "screen").is_err());
}
#[test]
fn validates_bounded_png_geometry() {
    assert!(validate_image(&[1, 2, 3]).is_err());
    let mut image = vec![0; 24];
    image[..8].copy_from_slice(&[137, 80, 78, 71, 13, 10, 26, 10]);
    image[12..16].copy_from_slice(b"IHDR");
    image[16..20].copy_from_slice(&1u32.to_be_bytes());
    image[20..24].copy_from_slice(&1u32.to_be_bytes());
    assert!(validate_image(&image).is_ok());
    image[16..20].copy_from_slice(&16385u32.to_be_bytes());
    assert!(validate_image(&image).is_err());
}
