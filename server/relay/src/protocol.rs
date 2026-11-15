//! Relay mux 帧解析（与浏览器 nos/peer/relay/mux.js 对应）
//!
//! u8 version=1
//! u8 type=1
//! u16 from_len + from utf8
//! u16 to_len + to utf8
//! .. inner PeerSession frame

const VERSION: u8 = 1;
const TYPE_DATA: u8 = 1;
pub const MAX_ID_BYTES: usize = 512;
pub const MAX_FRAME_BYTES: usize = 1024 * 1024 + 4096;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MuxFrame<'a> {
    pub from: &'a str,
    pub to: &'a str,
    pub inner: &'a [u8],
}

pub fn encode_mux_frame(from: &str, to: &str, inner: &[u8]) -> Vec<u8> {
    let mut out = vec![VERSION, TYPE_DATA];
    out.extend_from_slice(&(from.len() as u16).to_be_bytes());
    out.extend_from_slice(from.as_bytes());
    out.extend_from_slice(&(to.len() as u16).to_be_bytes());
    out.extend_from_slice(to.as_bytes());
    out.extend_from_slice(inner);
    out
}

pub fn parse_mux_frame(bytes: &[u8]) -> Result<MuxFrame<'_>, &'static str> {
    if bytes.len() < 4 {
        return Err("frame too short");
    }
    if bytes[0] != VERSION {
        return Err("unsupported mux version");
    }
    if bytes[1] != TYPE_DATA {
        return Err("unsupported mux type");
    }

    let mut offset = 2;
    let from_len = u16::from_be_bytes([bytes[offset], bytes[offset + 1]]) as usize;
    offset += 2;
    if from_len == 0 || from_len > MAX_ID_BYTES {
        return Err("invalid from length");
    }
    if offset + from_len > bytes.len() {
        return Err("truncated from id");
    }
    let from = std::str::from_utf8(&bytes[offset..offset + from_len])
        .map_err(|_| "from id is not utf8")?;
    offset += from_len;

    if offset + 2 > bytes.len() {
        return Err("truncated to length");
    }
    let to_len = u16::from_be_bytes([bytes[offset], bytes[offset + 1]]) as usize;
    offset += 2;
    if to_len == 0 || to_len > MAX_ID_BYTES {
        return Err("invalid to length");
    }
    if offset + to_len > bytes.len() {
        return Err("truncated to id");
    }
    let to =
        std::str::from_utf8(&bytes[offset..offset + to_len]).map_err(|_| "to id is not utf8")?;
    offset += to_len;

    let inner = &bytes[offset..];
    if inner.len() > MAX_FRAME_BYTES {
        return Err("inner frame too large");
    }
    if inner.is_empty() {
        return Err("empty inner frame");
    }

    Ok(MuxFrame { from, to, inner })
}

#[cfg(test)]
pub mod tests {
    pub fn encode_mux_for_test(from: &str, to: &str, inner: &[u8]) -> Vec<u8> {
        let mut out = vec![1u8, 1u8];
        out.extend_from_slice(&(from.len() as u16).to_be_bytes());
        out.extend_from_slice(from.as_bytes());
        out.extend_from_slice(&(to.len() as u16).to_be_bytes());
        out.extend_from_slice(to.as_bytes());
        out.extend_from_slice(inner);
        out
    }

    use super::*;

    fn encode(from: &str, to: &str, inner: &[u8]) -> Vec<u8> {
        let mut out = vec![VERSION, TYPE_DATA];
        out.extend_from_slice(&(from.len() as u16).to_be_bytes());
        out.extend_from_slice(from.as_bytes());
        out.extend_from_slice(&(to.len() as u16).to_be_bytes());
        out.extend_from_slice(to.as_bytes());
        out.extend_from_slice(inner);
        out
    }

    #[test]
    fn parses_valid_frame() {
        let bytes = encode("alice", "bob", &[1, 2, 3]);
        let parsed = parse_mux_frame(&bytes).unwrap();
        assert_eq!(parsed.from, "alice");
        assert_eq!(parsed.to, "bob");
        assert_eq!(parsed.inner, &[1, 2, 3]);
    }

    #[test]
    fn rejects_bad_version_and_truncation() {
        let mut bytes = encode("alice", "bob", &[1]);
        bytes[0] = 2;
        assert!(parse_mux_frame(&bytes).is_err());

        let bytes = encode("alice", "bob", &[1]);
        assert!(parse_mux_frame(&bytes[..4]).is_err());
        assert!(parse_mux_frame(&bytes[..6]).is_err());
    }
}
