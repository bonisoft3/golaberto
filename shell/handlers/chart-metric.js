(state, event) => ['points', 'position'].includes(event.value) ? event.value : state.items[0].metric
