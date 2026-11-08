//! The polling loop of a database source (prompt 019): batches in key order into the spool,
//! catching up without pause while batches are full, then one batch every `interval_ms`. A broken
//! connection: reconnect after 1, 2, 4 … 60 s and go on from the last key; a refused login stops
//! (no retries that lock accounts).

use super::driver::{Driver, Query, Request, BATCH_ROWS};
use super::sql::{self, Bound};
use super::value::{self, Edge, Key, MAX_EDGE};
use super::{DbConfig, Layout, Opener};
use crate::error::{AppError, ErrorCode};
use crate::model::SourceState;
use crate::remote::secrets::Secret;
use crate::sources::SourceContext;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

const MAX_BACKOFF_S: u32 = 60;

pub struct Follow {
    pub config: DbConfig,
    pub driver: Option<Box<dyn Driver>>,
    pub layout: Layout,
    pub secret: Option<Secret>,
    pub opener: Arc<Opener>,
    pub key_name: String,
}

/// Errors after which trying again is pointless or harmful.
fn permanent(e: &AppError) -> bool {
    matches!(
        e.code,
        ErrorCode::AuthFailed | ErrorCode::SecretRequired | ErrorCode::Unsupported
    )
}

enum Round {
    /// The batch was full: more right away.
    More,
    Idle,
}

pub fn run(mut f: Follow, ctx: SourceContext) {
    let stop = ctx.stop.clone();
    let stopped = move || stop.is_stopped();
    let mut edge: Option<Edge> = None;
    let mut attempt: u32 = 0;
    let mut line = String::new();
    let shape = f.layout.shape();
    let zone = chrono::Local;
    ctx.monitor.set_state(SourceState::Loading);
    while !ctx.stop.is_stopped() {
        let result = (|| -> Result<Round, AppError> {
            if f.driver.is_none() {
                let query = Query {
                    sql: sql::check_select(&f.config.query, f.config.engine)?,
                    key: f.key_name.clone(),
                };
                let mut driver = (f.opener)(&f.config, f.secret.as_ref(), query, &stopped)?;
                // The table may have changed while away.
                let probe = driver.run(&Request::Probe, &stopped)?;
                let layout = super::layout(&f.config, probe.columns)?;
                if layout != f.layout {
                    return Err(AppError::new(
                        ErrorCode::InvalidQuery,
                        "Die Spalten der Abfrage haben sich geändert; Tab neu öffnen",
                    ));
                }
                f.driver = Some(driver);
            }
            let driver = f.driver.as_mut().expect("connected");
            // Where to start: all rows, or the key of the n-th newest.
            let edge = match edge.as_mut() {
                Some(e) => e,
                None => {
                    let start = match f.config.start_last {
                        Some(n) => {
                            let r = driver.run(&Request::NthNewest(n), &stopped)?;
                            r.rows
                                .first()
                                .and_then(|row| row.first())
                                .and_then(value::Value::key)
                        }
                        None => None,
                    };
                    edge.insert(start.map_or_else(Edge::default, Edge::start_at))
                }
            };
            let (bound, limit) = match edge.last() {
                None => (Bound::None, BATCH_ROWS),
                Some(_) if edge.overflowed() => (Bound::After, BATCH_ROWS),
                Some(_) => (Bound::AtLeast, BATCH_ROWS + edge.len().min(MAX_EDGE) as u32),
            };
            if bound == Bound::After {
                // More rows with one key than can be remembered: rows that come later with that
                // same key are missed. Said in the status bar.
                edge.clear_rows();
                ctx.monitor.gaps.fetch_add(1, Ordering::Relaxed);
            }
            let last: Option<Key> = edge.last().cloned();
            let started = Instant::now();
            let rows = driver.run(
                &Request::Batch {
                    bound,
                    key: last.as_ref(),
                    limit,
                },
                &stopped,
            )?;
            let took = started.elapsed();
            ctx.monitor.latency_ms.store(
                took.as_millis().min(u32::MAX as u128 - 1) as u32,
                Ordering::Relaxed,
            );
            ctx.monitor.polled_at_ms.store(
                chrono::Utc::now().timestamp_millis().max(1) as u64,
                Ordering::Relaxed,
            );
            let full = rows.rows.len() >= limit as usize;
            let mut skipped = Vec::new();
            let mut written = 0u64;
            for row in &rows.rows {
                if ctx.stop.is_stopped() {
                    break;
                }
                let Some(key) = row.get(f.layout.key).and_then(value::Value::key) else {
                    ctx.monitor.rejected.fetch_add(1, Ordering::Relaxed);
                    continue;
                };
                let cut = value::json_line(&shape, row, &zone, &mut line);
                if !edge.admit(&key, &line) {
                    skipped.push((key, line.clone()));
                    continue;
                }
                if !ctx
                    .writer
                    .line_blocking(line.as_bytes().to_vec(), &ctx.stop)
                {
                    break;
                }
                edge.written(key, &line);
                written += 1;
                ctx.monitor.received.fetch_add(1, Ordering::Relaxed);
                if cut {
                    ctx.monitor.truncated.fetch_add(1, Ordering::Relaxed);
                }
            }
            edge.restore(&skipped);
            ctx.monitor.counted();
            // A full batch of only known edge rows would loop: the edge is too big for the limit.
            Ok(if full && written > 0 {
                Round::More
            } else {
                Round::Idle
            })
        })();
        match result {
            Ok(round) => {
                attempt = 0;
                match round {
                    Round::More => ctx.monitor.set_state(SourceState::Loading),
                    Round::Idle => {
                        ctx.monitor.set_state(SourceState::Connected);
                        ctx.monitor.flush();
                        sleep(&ctx, Duration::from_millis(u64::from(f.config.interval_ms)));
                    }
                }
            }
            Err(_) if ctx.stop.is_stopped() => break,
            Err(e) if permanent(&e) => {
                f.driver = None;
                ctx.monitor
                    .set_state(SourceState::Error { message: e.message });
                // Nothing more to do; the lines stay. Waits for the tab to close.
                while !ctx.stop.is_stopped() {
                    sleep(&ctx, Duration::from_millis(200));
                }
            }
            Err(e) => {
                f.driver = None;
                let wait = (1u32 << attempt.min(6)).min(MAX_BACKOFF_S);
                attempt += 1;
                for left in (1..=wait).rev() {
                    if ctx.stop.is_stopped() {
                        break;
                    }
                    ctx.monitor.set_state(SourceState::Reconnecting {
                        message: e.message.clone(),
                        retry_in_s: left,
                    });
                    sleep(&ctx, Duration::from_secs(1));
                }
            }
        }
    }
}

fn sleep(ctx: &SourceContext, total: Duration) {
    let start = Instant::now();
    while !ctx.stop.is_stopped() && start.elapsed() < total {
        std::thread::sleep((total - start.elapsed()).min(Duration::from_millis(50)));
    }
}
