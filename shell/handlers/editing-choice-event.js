({ context, event }, params) => event.from === context.items[0].id + params.suffix
