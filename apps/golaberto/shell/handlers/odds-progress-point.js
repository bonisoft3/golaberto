(state, event) => Math.round(Math.max(0,Math.min(1,(event.pointerX * 0.64 - 52) / 574)) * state.items[0].snapshot_last)
