// 共享与按键说话共用页面；最后一个用途结束后才恢复原节流状态。
function createMediaBackgroundPolicy() {
  const renderers = new WeakMap();
  return (renderer, owner, active) => {
    if (!renderer || renderer.isDestroyed()) return;
    let state = renderers.get(renderer);
    if (!state && active) {
      state = { original: renderer.getBackgroundThrottling(), owners: new Set() };
      renderers.set(renderer, state);
    }
    if (!state) return;
    if (active) state.owners.add(owner);
    else state.owners.delete(owner);
    renderer.setBackgroundThrottling(state.owners.size ? false : state.original);
    if (!state.owners.size) renderers.delete(renderer);
  };
}

module.exports = { createMediaBackgroundPolicy };
