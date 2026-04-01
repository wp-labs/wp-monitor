/// 计算可序列化对象的稳定哈希（用于层版本号）。
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

pub fn stable_hash_json<T: serde::Serialize>(value: &T) -> String {
    // 先转 JSON 字符串，再做哈希，保证同结构同结果。
    let s = serde_json::to_string(value).unwrap_or_default();
    let mut hasher = DefaultHasher::new();
    s.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}
