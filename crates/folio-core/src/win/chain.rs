//! Chains of records as Windows fills buffers with them, for directory listings and change
//! records: each record starts with the offset of the next one, 0 on the last, and ends with a
//! name of UTF-16 units. Safe code over bytes: a record that does not fit its buffer is an error.

use std::io;

/// Where the fields that every record of one kind has are.
pub(super) struct Chain {
    /// The offset of the next record.
    pub next: usize,
    /// The name's length in bytes.
    pub name_length: usize,
    /// The name, which comes after every fixed field.
    pub name: usize,
    /// What the records are, for errors.
    pub what: &'static str,
}

/// One record: its bytes from its start, which hold every fixed field, and its name.
pub(super) struct Link<'a> {
    bytes: &'a [u8],
    name: &'a [u8],
}

impl Link<'_> {
    /// The bytes of the fixed field at `offset`.
    pub fn field<const N: usize>(&self, offset: usize) -> [u8; N] {
        self.bytes[offset..offset + N]
            .try_into()
            .expect("a fixed field comes before the name")
    }

    /// The name's UTF-16 units.
    pub fn name(&self) -> impl Iterator<Item = u16> + '_ {
        self.name
            .chunks_exact(2)
            .map(|unit| u16::from_le_bytes([unit[0], unit[1]]))
    }
}

impl Chain {
    /// Hands each record in `buffer` to `each`, in order, until the last or an error.
    pub fn walk<'a>(
        &self,
        buffer: &'a [u8],
        mut each: impl FnMut(Link<'a>) -> io::Result<()>,
    ) -> io::Result<()> {
        let mut start = 0;
        loop {
            let bytes = buffer
                .get(start..)
                .filter(|bytes| bytes.len() >= self.name)
                .ok_or_else(|| self.malformed("a record runs past the buffer"))?;
            let usize_at = |offset: usize| {
                u32::from_le_bytes(bytes[offset..offset + 4].try_into().expect("4 bytes")) as usize
            };
            let (next, length) = (usize_at(self.next), usize_at(self.name_length));
            let name = bytes
                .get(self.name..self.name + length)
                .filter(|name| name.len().is_multiple_of(2))
                .ok_or_else(|| self.malformed("a name runs past its record"))?;
            if next != 0 && next < self.name + length {
                return Err(self.malformed("records overlap"));
            }
            each(Link { bytes, name })?;
            if next == 0 {
                return Ok(());
            }
            start += next;
        }
    }

    pub fn malformed(&self, what: &str) -> io::Error {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("malformed {}: {what}", self.what),
        )
    }

    /// Records laid out as Windows lays them out, each padded to 8 bytes, from their names and
    /// their other fixed fields as offsets and bytes.
    #[cfg(test)]
    pub fn lay_out(
        &self,
        records: impl IntoIterator<Item = (Vec<u16>, Vec<(usize, Vec<u8>)>)>,
    ) -> Vec<u8> {
        let mut buffer = Vec::new();
        let mut last: Option<usize> = None;
        for (name, fields) in records {
            let start = buffer.len();
            if let Some(last) = last {
                let next = u32::try_from(start - last).unwrap();
                buffer[last + self.next..][..4].copy_from_slice(&next.to_le_bytes());
            }
            buffer.resize(start + self.name, 0);
            let length = u32::try_from(name.len() * 2).unwrap();
            buffer[start + self.name_length..][..4].copy_from_slice(&length.to_le_bytes());
            for (offset, bytes) in fields {
                buffer[start + offset..][..bytes.len()].copy_from_slice(&bytes);
            }
            buffer.extend(name.iter().flat_map(|unit| unit.to_le_bytes()));
            buffer.resize(buffer.len().next_multiple_of(8), 0);
            last = Some(start);
        }
        buffer
    }
}
