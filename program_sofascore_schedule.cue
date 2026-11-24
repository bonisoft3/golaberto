package golaberto

import pronto "github.com/bonisoft3/pronto"

// Instants are epoch milliseconds; 0 is none.
_sofaInstant: {type: "integer", min: 0, max: 9007199254740991}
// Milliseconds from a step to the instant its state's timer is due.
_sofaWait: {type: "integer", min: 0, max: 9007199254740991}
_sofaCount: {type: "integer", min: 0, max: 1000000}
_sofaFamily: {type: "string", maxLength: 9, values: ["rounds", "round", "event", "lineups", "incidents"]}
_sofaResourcePhases: ["due", "acquiring", "idle", "backoff", "review", "done", "answered", "refused"]
_sofaResource: {
	family:          _sofaFamily
	due:             _sofaInstant
	failures:        _sofaCount
	checks:          _sofaCount
	complete_checks: _sofaCount
	complete: {type: "boolean"}
	settled: {type: "boolean"}
	status: {type: "integer", min: 0, max: 999}
}
// What a fetched round or event owes: its events still unsettled and the
// fixtures still pending, each with its kickoff and calendar day.
_sofaOwed: {type: "array", maxItems: 128, items: {type: "object", fields: {
	status: {type: "string", maxLength: 16}
	kickoff: _sofaInstant
	day:     _sofaInstant
}}}

// One instance per resource: when it is next due, how it backs off, and when
// its details give up. Admission, the source budget and priority are SQL's,
// since they are decided over every resource at once. A waiting state's timer
// is XState's after, due `wait` after the step that entered it, which every
// action setting `due` sets to the time left until it.
_sofaResourceMachine: pronto.#Machine & {
	config: {
		id:      "sofa_resource"
		initial: "idle"
		on: {
			fetched: {target: "answered", actions: "answer"}
			failed: {target: "refused", actions: "fail"}
			// Each moves `due`, so each enters idle again, an idle resource
			// included, and its timer starts over at the time left.
			reopened: {target: "idle", reenter: true, actions: "reopen"}
			paired: {target: "idle", reenter: true, actions: "pair"}
			stopped: {target: "done", actions: "stop"}
		}
		states: {
			due: on: admitted: {target: "acquiring", actions: "admit"}
			for s in ["acquiring", "idle", "backoff"] {(s): after: ripe: {target: "due"}}
			// A fixture seen again pulls an idle resource's next ask forward:
			// re-entering idle starts its timer from the step, `wait` after it.
			idle: on: hasten: {target: "idle", reenter: true, actions: "hasten"}
			for s in ["due", "acquiring", "backoff", "answered", "refused", "review", "done"] {(s): on: hasten: {actions: "hasten"}}
			// Where an answer or a refusal leaves the resource, read off what it made of it.
			answered: always: [{guard: "givenUp", target: "review"}, {guard: "finished", target: "done"}, {target: "idle"}]
			refused: always: [{guard: "givenUp", target: "review"}, {target: "backoff"}]
			review: {}
			done: {}
		}
	}
	setup: {
		initialize: "initial"
		delays: ripe: "wait"
		guards: {
			givenUp: reads: []
			finished: reads: []
		}
		actions: {
			admit: {reads: ["_time"], writes: ["due", "wait"]}
			answer: {reads: ["_time", "owed", "unresolved", "terminal", "kept", "fixtures", "complete", "max_age", "ends"], writes: ["due", "wait", "failures", "checks", "complete_checks", "complete", "settled", "status"]}
			fail: {reads: ["_time", "status", "retry_at"], writes: ["due", "wait", "failures", "status"]}
			hasten: {reads: ["_time", "owed"], writes: ["due", "wait"]}
			reopen: {reads: ["_time"], writes: ["due", "wait", "checks", "complete_checks", "complete"]}
			pair: {reads: ["_time"], writes: ["due", "wait", "complete", "complete_checks"]}
			stop: {reads: [], writes: ["due", "wait"]}
		}
		version: 1
		fuel:    20000
		types: {
			// Spawned due at `due`, or, owing fixtures, when the soonest of them is.
			input: {type: "object", fields: {family: _sofaFamily, due: _sofaInstant, owed: _sofaOwed}}
			context: {type: "object", fields: {_sofaResource, wait: _sofaWait}}
			view: {type: "object", fields: {_sofaResource, phase: {type: "string", maxLength: 9, values: _sofaResourcePhases}}}
			events: {
				admitted: {tier: "mecha", payload: {type: "object", fields: {request: {type: "string", maxLength: 36}}}}
				fetched: {tier: "mecha", payload: {type: "object", fields: {
					owed: _sofaOwed
					// Kept events, and whether all of them are terminal.
					kept: {type: "boolean"}
					terminal: {type: "boolean"}
					unresolved: {type: "boolean"}
					// A fixtures-scope source polls fixtures, not rounds.
					fixtures: {type: "boolean"}
					// A detail's pair completed and applied.
					complete: {type: "boolean"}
					// Cache-Control max-age in seconds, or -1.
					max_age: {type: "integer", min: -1, max: 31536000}
					// The championship's last day, 0 when it has none.
					ends: _sofaInstant
				}}}
				failed: {tier: "mecha", payload: {type: "object", fields: {
					status: {type: "integer", min: 0, max: 999}
					// The instant Retry-After names, 0 when it names none.
					retry_at: _sofaInstant
				}}}
				hasten: {tier: "mecha", payload: {type: "object", fields: {owed: _sofaOwed}}}
				reopened: {tier: "mecha", payload: {type: "object", fields: {}}}
				paired: {tier: "mecha", payload: {type: "object", fields: {}}}
				stopped: {tier: "mecha", payload: {type: "object", fields: {}}}
			}
		}
	}
}

_sofaProviderPhases: ["open", "paused", "blocked", "judged"]
_sofaProvider: {
	reason: {type: "string", maxLength: 32}
	until:  _sofaInstant
}
// The provider's standing: a 401 or 403 pauses it until an operator resumes
// it, a 429 blocks it until the instant the refusal named, the blocked
// state's timer due `wait` after the refusal. Admission asks it before
// admitting anything.
_sofaProviderMachine: pronto.#Machine & {
	config: {
		id:      "sofa_provider"
		initial: "open"
		on: {
			refused: {target: "judged", actions: "refuse"}
			resumed: {target: "open", actions: "resume"}
		}
		states: {
			open: {}
			paused: {}
			blocked: after: block: {target: "open", actions: "resume"}
			// A pause outranks a block, and a block outlives a lesser refusal.
			judged: always: [{guard: "isPaused", target: "paused"}, {guard: "isBlocked", target: "blocked"}, {target: "open"}]
		}
	}
	setup: {
		initialize: "initial"
		delays: block: "wait"
		guards: {
			isPaused: reads: []
			isBlocked: reads: []
		}
		actions: {
			refuse: {reads: ["_time", "status", "until"], writes: ["reason", "until", "wait"]}
			resume: {reads: [], writes: ["reason", "until", "wait"]}
		}
		version: 1
		types: {
			input: {type: "object", fields: {}}
			context: {type: "object", fields: {_sofaProvider, wait: _sofaWait}}
			view: {type: "object", fields: {_sofaProvider, phase: {type: "string", maxLength: 7, values: _sofaProviderPhases}}}
			events: {
				refused: {tier: "mecha", payload: {type: "object", fields: {
					status: {type: "integer", min: 0, max: 999}
					until:  _sofaInstant
				}}}
				resumed: {tier: "mecha", payload: {type: "object", fields: {}}}
			}
		}
	}
}

loop: surface: checks: "sofascore-schedule": {
	verb: "test"
	cmds: ["\(pronto.#Harness.rule); mise exec -- deno test \(pronto.#Harness.flags) --allow-read --allow-env tests/sofascore-schedule.ts"]
	note: "the resource and provider reducers schedule as tools/sofascore/schedule.py did, give up as it did, and hold their invariants under a random walk"
}
code: state: mecha: reducers: {
	sofa_resource: {machine: _sofaResourceMachine, rules: "machines/sofa_resource.js"}
	sofa_provider: {machine: _sofaProviderMachine, rules: "machines/sofa_provider.js"}
}

// The seats a reducer writes at every accepted step: the service actor's
// only, since no reader opens these instances.
code: state: entities: {
	SofaResourceSeat: {
		id: "0xccc18979b19a17f7"
		table:      "sofa_resource_seat"
		durability: "live"
		access: {scope: "private", owner: "actor"}
		fields: [
			{ordinal: 1, name: "id", type: "text", pk: true, cel: "this.size() <= 64"},
			{ordinal: 2, name: "instance_id", type: "uuid"},
			{ordinal: 3, name: "actor", type: "uuid"},
			{ordinal: 4, name: "seat", type: "text", cel: "this.size() <= 16"},
			{ordinal: 5, name: "revision", type: "bigint"},
			{ordinal: 6, name: "phase", type: "text", cel: "this.size() <= 16"},
			{ordinal: 7, name: "view", type: "json", cel: (pronto.#ShapeCel & {shape: _sofaResourceMachine.setup.types.view}).out},
		]
	}
	SofaProviderSeat: {
		id: "0x8a75bfd71ff551af"
		table:      "sofa_provider_seat"
		durability: "live"
		access: {scope: "private", owner: "actor"}
		fields: [
			{ordinal: 1, name: "id", type: "text", pk: true, cel: "this.size() <= 64"},
			{ordinal: 2, name: "instance_id", type: "uuid"},
			{ordinal: 3, name: "actor", type: "uuid"},
			{ordinal: 4, name: "seat", type: "text", cel: "this.size() <= 16"},
			{ordinal: 5, name: "revision", type: "bigint"},
			{ordinal: 6, name: "phase", type: "text", cel: "this.size() <= 16"},
			{ordinal: 7, name: "view", type: "json", cel: (pronto.#ShapeCel & {shape: _sofaProviderMachine.setup.types.view}).out},
		]
	}
}
