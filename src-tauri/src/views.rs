//! Several views of one session (prompt 013): a filter opened as a tab of its own. All views share the
//! index, the worker, the handles and the encoding; each has its own filtered list.
//!
//! A view below another one (drill-down) shows the result of its parent and filters further: its
//! effective filter is the chain of its ancestors AND its own filter, composed here into one request
//! (levels and sources intersected, the ancestors' trees and filtering searches as one AND group in
//! front of the view's own tree). Closing a view hands its part of the chain down to its children
//! (`inherited`), so they stay the same.

use crate::filter::{LevelMask, SearchMode, SearchQuery, SourceMask};
use crate::filter_expr::{Cond, FilterExpr, GroupOp};

/// Views per file; each one costs up to 4 bytes per line and time per new line.
pub const MAX_VIEWS: usize = 8;

/// What the user set for one view, as `set_filter` sends it.
#[derive(Debug, Clone, PartialEq)]
pub struct ViewFilter {
    pub levels: LevelMask,
    pub query: SearchQuery,
    pub mode: SearchMode,
    pub sources: SourceMask,
    pub expr: Option<FilterExpr>,
}

impl Default for ViewFilter {
    fn default() -> Self {
        Self {
            levels: LevelMask::ALL,
            query: SearchQuery::default(),
            mode: SearchMode::Filter,
            sources: SourceMask::ALL,
            expr: None,
        }
    }
}

impl ViewFilter {
    /// The terms this filter adds to the expression of a view below it: its tree, and its search
    /// when that filters (a highlighting search marks only its own view).
    fn chain_terms(&self, index: usize, out: &mut Vec<FilterExpr>) {
        if let Some(expr) = &self.expr {
            out.push(expr.clone());
        }
        if self.mode == SearchMode::Filter && !self.query.text.is_empty() {
            out.push(FilterExpr::Cond {
                id: format!("chain:{index}:search"),
                negate: false,
                cond: Cond::Text(self.query.clone()),
            });
        }
    }
}

/// The effective request of a view, ready to compile.
#[derive(Debug, Clone, PartialEq)]
pub struct Composed {
    pub levels: LevelMask,
    pub query: SearchQuery,
    pub mode: SearchMode,
    pub sources: SourceMask,
    pub expr: Option<FilterExpr>,
}

/// Id of the group that joins a chain; errors in it name the node inside, not this one.
pub const CHAIN_GROUP_ID: &str = "chain";

/// The filter of a view below `chain` (outermost first, inherited parts included): levels and sources
/// of all, the view's own search, and one AND of the ancestors' terms and the own tree. Without a
/// chain this is the own filter unchanged, so view 0 behaves as before.
pub fn compose(chain: &[&ViewFilter], own: &ViewFilter) -> Composed {
    let mut levels = own.levels;
    let mut sources = own.sources;
    let mut terms = Vec::new();
    for (index, part) in chain.iter().enumerate() {
        levels = levels.intersect(part.levels);
        sources = SourceMask(sources.0 & part.sources.0);
        part.chain_terms(index, &mut terms);
    }
    let expr = if terms.is_empty() {
        own.expr.clone()
    } else {
        terms.extend(own.expr.clone());
        if terms.len() == 1 {
            terms.pop()
        } else {
            Some(FilterExpr::Group {
                id: CHAIN_GROUP_ID.into(),
                op: GroupOp::And,
                negate: false,
                children: terms,
            })
        }
    };
    Composed {
        levels,
        query: own.query.clone(),
        mode: own.mode,
        sources,
        expr,
    }
}

/// The filter narrows nothing a view below could inherit.
pub fn is_unfiltered(filter: &ViewFilter) -> bool {
    filter.levels == LevelMask::ALL
        && (filter.query.text.is_empty() || filter.mode == SearchMode::Highlight)
        && filter.sources == SourceMask::ALL
        && filter.expr.is_none()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::level::Level;

    fn text(id: &str, t: &str) -> FilterExpr {
        FilterExpr::Cond {
            id: id.into(),
            negate: false,
            cond: Cond::Text(SearchQuery {
                text: t.into(),
                is_regex: false,
                case_sensitive: false,
            }),
        }
    }

    fn search(t: &str, mode: SearchMode) -> ViewFilter {
        ViewFilter {
            query: SearchQuery {
                text: t.into(),
                is_regex: false,
                case_sensitive: false,
            },
            mode,
            ..ViewFilter::default()
        }
    }

    #[test]
    fn without_a_chain_the_own_filter_is_unchanged() {
        let own = ViewFilter {
            levels: LevelMask::from_levels(&[Level::Error]),
            expr: Some(text("a", "x")),
            ..search("y", SearchMode::Filter)
        };
        let c = compose(&[], &own);
        assert_eq!(c.levels, own.levels);
        assert_eq!(c.expr, own.expr);
        assert_eq!(c.query, own.query);
    }

    #[test]
    fn levels_and_sources_intersect_and_terms_join_with_and() {
        let parent = ViewFilter {
            levels: LevelMask::from_levels(&[Level::Error, Level::Warn]),
            sources: SourceMask(0b011),
            expr: Some(text("p", "order")),
            ..search("4711", SearchMode::Filter)
        };
        let own = ViewFilter {
            levels: LevelMask::from_levels(&[Level::Error, Level::Info]),
            sources: SourceMask(0b110),
            expr: Some(text("o", "service")),
            ..search("mark", SearchMode::Highlight)
        };
        let c = compose(&[&parent], &own);
        assert_eq!(c.levels, LevelMask::from_levels(&[Level::Error]));
        assert_eq!(c.sources, SourceMask(0b010));
        assert_eq!(c.mode, SearchMode::Highlight);
        assert_eq!(c.query.text, "mark");
        let Some(FilterExpr::Group { op, children, .. }) = c.expr else {
            panic!("a group")
        };
        assert_eq!(op, GroupOp::And);
        assert_eq!(children.len(), 3);
        assert_eq!(children[0], text("p", "order"));
        assert!(
            matches!(&children[1], FilterExpr::Cond { cond: Cond::Text(q), .. } if q.text == "4711")
        );
        assert_eq!(children[2], text("o", "service"));
    }

    #[test]
    fn a_highlighting_search_above_does_not_filter_below() {
        let parent = search("x", SearchMode::Highlight);
        let c = compose(&[&parent], &ViewFilter::default());
        assert_eq!(c.expr, None);
        assert!(is_unfiltered(&parent));
    }

    #[test]
    fn a_single_term_is_not_wrapped() {
        let parent = search("x", SearchMode::Filter);
        let c = compose(&[&parent], &ViewFilter::default());
        assert!(matches!(c.expr, Some(FilterExpr::Cond { .. })));
    }
}
