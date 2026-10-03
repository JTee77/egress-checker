//! 卡片到点后，前端用同一个 cancel id 通知这边丢掉还在飞的代理请求。
//! 取消可能比请求登记更早到，所以先到的 id 先记下来，请求一开始就能看见。
//! 不用单独依赖 tokio：现有运行时能把这个等待唤醒即可。

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};

struct Slot {
    cancelled: bool,
    waker: Option<Waker>,
}

struct Reg {
    live: HashMap<String, Arc<Mutex<Slot>>>,
    early: HashSet<String>,
}

fn reg() -> &'static Mutex<Reg> {
    static REG: std::sync::OnceLock<Mutex<Reg>> = std::sync::OnceLock::new();
    REG.get_or_init(|| {
        Mutex::new(Reg {
            live: HashMap::new(),
            early: HashSet::new(),
        })
    })
}

/// 等到对应的取消号被点着。
pub struct CancelWait {
    slot: Arc<Mutex<Slot>>,
}

impl Future for CancelWait {
    type Output = ();

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        let mut slot = self.slot.lock().unwrap_or_else(|e| e.into_inner());
        if slot.cancelled {
            Poll::Ready(())
        } else {
            slot.waker = Some(cx.waker().clone());
            Poll::Pending
        }
    }
}

/// 登记一个取消号。已经取消过则返回 None，调用方不要再发请求。
pub fn arm_cancel(id: &str) -> Option<CancelWait> {
    let mut g = reg().lock().unwrap_or_else(|e| e.into_inner());
    if g.early.remove(id) {
        return None;
    }
    let slot = Arc::new(Mutex::new(Slot {
        cancelled: false,
        waker: None,
    }));
    if let Some(old) = g.live.insert(id.to_string(), Arc::clone(&slot)) {
        let mut prev = old.lock().unwrap_or_else(|e| e.into_inner());
        prev.cancelled = true;
        if let Some(waker) = prev.waker.take() {
            waker.wake();
        }
    }
    Some(CancelWait { slot })
}

pub fn disarm_cancel(id: &str) {
    let mut g = reg().lock().unwrap_or_else(|e| e.into_inner());
    g.live.remove(id);
    g.early.remove(id);
}

/// 通知这个号停掉。请求还没登记时先记住，返回 false。
pub fn fire_cancel(id: &str) -> bool {
    let mut g = reg().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(slot) = g.live.remove(id) {
        let mut inner = slot.lock().unwrap_or_else(|e| e.into_inner());
        inner.cancelled = true;
        if let Some(waker) = inner.waker.take() {
            waker.wake();
        }
        return true;
    }
    if g.early.len() > 512 {
        g.early.clear();
    }
    g.early.insert(id.to_string());
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_before_arm_is_visible() {
        let id = format!("early-{}-{}", std::process::id(), line!());
        assert!(!fire_cancel(&id));
        assert!(arm_cancel(&id).is_none());
    }

    #[test]
    fn cancel_after_arm_wakes() {
        let id = format!("live-{}-{}", std::process::id(), line!());
        let wait = arm_cancel(&id).expect("armed");
        assert!(fire_cancel(&id));
        tauri::async_runtime::block_on(wait);
        disarm_cancel(&id);
    }
}
