//! A database in memory for the tests of the polling logic (prompt 019): it answers the requests
//! like the wrapped SQL does (order by key, `>=`/`>`, limit, NULL keys never), returns rows with
//! the same key in a changing order, and can fail or refuse logins on demand.

use super::driver::{Driver, Query, Request, Rows, Stop, TableName};
use super::sql::{Bound, Dialect};
use super::value::{Column, Key, Value};
use super::{DbConfig, Opener};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::remote::secrets::Secret;
use parking_lot::Mutex;
use std::cmp::Ordering;
use std::sync::Arc;

#[derive(Default)]
pub struct State {
    pub columns: Vec<Column>,
    pub rows: Vec<Vec<Value>>,
    /// The password it accepts; None: any.
    pub password: Option<String>,
    /// The next requests fail with this (connection lost).
    pub fail_requests: u32,
    /// Connecting fails while set.
    pub down: bool,
    pub connects: u32,
    pub batches: u32,
    /// Ties come reversed every other request.
    flip: bool,
}

#[derive(Clone, Default)]
pub struct FakeDb {
    pub state: Arc<Mutex<State>>,
}

pub fn cmp_key(a: &Key, b: &Key) -> Option<Ordering> {
    match (a, b) {
        (Key::I64(a), Key::I64(b)) => Some(a.cmp(b)),
        (Key::U64(a), Key::U64(b)) => Some(a.cmp(b)),
        (Key::F64(a), Key::F64(b)) => a.partial_cmp(b),
        (Key::Text(a), Key::Text(b)) => Some(a.cmp(b)),
        (Key::Ts(a), Key::Ts(b)) => Some(a.cmp(b)),
        (Key::TsTz(a), Key::TsTz(b)) => Some(a.cmp(b)),
        (Key::Date(a), Key::Date(b)) => Some(a.cmp(b)),
        _ => None,
    }
}

impl FakeDb {
    pub fn opener(&self) -> Arc<Opener> {
        let db = self.clone();
        Arc::new(
            move |config: &DbConfig, secret: Option<&Secret>, query: Query, _stop: Stop| {
                let mut s = db.state.lock();
                if s.down {
                    return Err(AppError::new(
                        ErrorCode::ConnectionFailed,
                        format!("{} nicht erreichbar", config.where_label()),
                    ));
                }
                if let Some(pw) = &s.password {
                    if secret.map(Secret::expose) != Some(pw.as_str()) {
                        return Err(super::auth_error(config, "Anmeldung abgelehnt"));
                    }
                }
                s.connects += 1;
                drop(s);
                Ok(Box::new(Conn {
                    db: db.clone(),
                    query,
                }) as Box<dyn Driver>)
            },
        )
    }
}

struct Conn {
    db: FakeDb,
    query: Query,
}

impl Driver for Conn {
    fn dialect(&self) -> Dialect {
        Dialect::Sqlite
    }

    fn set_key(&mut self, key: String) {
        self.query.key = key;
    }

    fn run(&mut self, request: &Request, _stop: Stop) -> AppResult<Rows> {
        let mut s = self.db.state.lock();
        if s.fail_requests > 0 {
            s.fail_requests -= 1;
            return Err(AppError::new(
                ErrorCode::ConnectionFailed,
                "Verbindung verloren",
            ));
        }
        let columns = s.columns.clone();
        let key = columns.iter().position(|c| c.name == self.query.key);
        let key_of = |row: &Vec<Value>| key.and_then(|k| row[k].key());
        s.flip = !s.flip;
        let flip = s.flip;
        let mut sorted: Vec<Vec<Value>> = s
            .rows
            .iter()
            .filter(|r| key_of(r).is_some())
            .cloned()
            .collect();
        sorted.sort_by(|a, b| cmp_key(&key_of(a).unwrap(), &key_of(b).unwrap()).unwrap());
        if flip {
            // Same order of keys, ties reversed.
            sorted.reverse();
            sorted.sort_by(|a, b| cmp_key(&key_of(a).unwrap(), &key_of(b).unwrap()).unwrap());
        }
        let rows = match request {
            Request::Probe => Vec::new(),
            Request::Preview => s.rows.iter().take(20).cloned().collect(),
            Request::Batch {
                bound,
                key: k,
                limit,
            } => {
                s.batches += 1;
                sorted
                    .into_iter()
                    .filter(|r| {
                        let rk = key_of(r).unwrap();
                        match (bound, k) {
                            (Bound::AtLeast, Some(k)) => cmp_key(&rk, k) != Some(Ordering::Less),
                            (Bound::After, Some(k)) => cmp_key(&rk, k) == Some(Ordering::Greater),
                            _ => true,
                        }
                    })
                    .take(*limit as usize)
                    .collect()
            }
            Request::NthNewest(n) => sorted
                .iter()
                .rev()
                .nth(*n as usize - 1)
                .map(|r| vec![r[key.unwrap()].clone()])
                .into_iter()
                .collect(),
        };
        Ok(Rows { columns, rows })
    }

    fn tables(&mut self, _stop: Stop) -> AppResult<Vec<TableName>> {
        Ok(vec![TableName {
            schema: Some("app".into()),
            name: "logs".into(),
        }])
    }
}
