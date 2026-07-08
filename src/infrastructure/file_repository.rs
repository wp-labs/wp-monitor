use crate::shared::error::{AppError, AppReason};
use bstr::ByteSlice;
use memchr::memrchr_iter;
use memmap2::Mmap;
use orion_error::prelude::*;
use std::fs::File;
use std::process::Command;

pub struct FileRepository {
    file: File,
    file_path: String,
}

impl FileRepository {
    pub fn new(file_path: &str) -> Result<Self, AppError> {
        let file = File::open(file_path).source_err(AppReason::FileReadFailed, "open miss file")?;
        Ok(Self {
            file,
            file_path: file_path.to_string(),
        })
    }

    pub fn tail_records(&self, limit: usize) -> Result<Vec<String>, AppError> {
        let mmap = self.mmap()?;
        let records = last_records(&mmap, limit);
        Ok(records
            .into_iter()
            .map(|r| r.to_str_lossy().to_string())
            .collect())
    }

    /// 统计 miss 记录总数（每条记录固定 6 行，调用系统 wc -l 统计总行数 / 6）。
    pub fn count_records(&self) -> Result<usize, AppError> {
        let output = Command::new("wc")
            .arg("-l")
            .arg(&self.file_path)
            .output()
            .source_err(AppReason::FileReadFailed, "run wc -l")?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let lines: usize = stdout
            .split_whitespace()
            .next()
            .unwrap_or("0")
            .parse()
            .unwrap_or(0);
        Ok(lines / 6)
    }

    fn mmap(&self) -> Result<Mmap, AppError> {
        unsafe { Mmap::map(&self.file) }.source_err(AppReason::FileReadFailed, "mmap miss file")
    }
}

/// 返回空白行分隔符占用的字节数（Unix: \n\n 占 2，Windows: \r\n\r\n 占 4）
fn blank_line_sep(data: &[u8], pos: usize) -> Option<usize> {
    if pos > 0 && data[pos - 1] == b'\n' {
        return Some(2);
    }
    if pos >= 3 && data[pos - 3..=pos] == [b'\r', b'\n', b'\r', b'\n'] {
        return Some(4);
    }
    None
}

/// 获取最后 n 条记录
fn last_records(data: &[u8], limit: usize) -> Vec<&[u8]> {
    let mut records = Vec::with_capacity(limit);

    let mut end = data.len();

    // 从尾部反向扫描 '\n'
    for pos in memrchr_iter(b'\n', data) {
        if let Some(sep) = blank_line_sep(data, pos) {
            let start = pos + 1;

            if start < end {
                let slice = &data[start..end];

                if !slice.trim().is_empty() {
                    records.push(slice);

                    if records.len() >= limit {
                        break;
                    }
                }
            }

            end = pos + 1 - sep;
        }
    }

    // 文件头部剩余部分
    if records.len() < limit && end > 0 {
        let slice = &data[..end];

        if !slice.trim().is_empty() {
            records.push(slice);
        }
    }

    records
}
