package golaberto

import pronto "github.com/bonisoft3/pronto"

// Instants are epoch milliseconds; 0 is none.
_sofaInstant: {type: "integer", min: 0, max: 9007199254740991}
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
// since they are decided over every resource at once.
_sofaResourceMachine: pronto.#Machine & {
	config: {
		id:      "sofa_resource"
		initial: "idle"
		on: {
			fetched: {target: "answered", actions: "answer"}
			failed: {target: "refused", actions: "fail"}
			hasten: {actions: "hasten"}
			reopened: {target: "idle", actions: "reopen"}
			paired: {target: "idle", actions: "pair"}
			stopped: {target: "done", actions: "stop"}
		}
		states: {
			due: on: admitted: {target: "acquiring", actions: "admit"}
			acquiring: on: ripe: {guard: "isDue", target: "due"}
			idle: on: ripe: {guard: "isDue", target: "due"}
			backoff: on: ripe: {guard: "isDue", target: "due"}
			// Where an answer or a refusal leaves the resource, read off what it made of it.
			answered: always: [{guard: "givenUp", target: "review"}, {guard: "finished", target: "done"}, {target: "idle"}]
			refused: always: [{guard: "givenUp", target: "review"}, {target: "backoff"}]
			review: {}
			done: {}
		}
	}
	setup: {
		initialize: "initial"
		guards: {
			isDue: {reads: ["_time"], reason: "not_due"}
			givenUp: reads: []
			finished: reads: []
		}
		actions: {
			admit: {reads: ["_time"], writes: ["due"]}
			answer: {reads: ["_time", "owed", "unresolved", "terminal", "kept", "fixtures", "complete", "max_age", "ends"], writes: ["due", "failures", "checks", "complete_checks", "complete", "settled", "status"]}
			fail: {reads: ["_time", "status", "retry_at"], writes: ["due", "failures", "status"]}
			hasten: {reads: ["_time", "owed"], writes: ["due"]}
			reopen: {reads: ["_time"], writes: ["due", "checks", "complete_checks", "complete"]}
			pair: {reads: ["_time"], writes: ["due", "complete", "complete_checks"]}
			stop: {reads: [], writes: ["due"]}
		}
		version: 1
		fuel:    20000
		types: {
			// Spawned due at `due`, or, owing fixtures, when the soonest of them is.
			input: {type: "object", fields: {family: _sofaFamily, due: _sofaInstant, owed: _sofaOwed}}
			context: {type: "object", fields: _sofaResource}
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
				ripe: {tier: "mecha", payload: {type: "object", fields: {}}}
			}
		}
		ports: wake: {phases: ["acquiring", "idle", "backoff"], deadline: "due", event: "ripe"}
	}
}

_sofaProviderPhases: ["open", "paused", "blocked", "judged"]
_sofaProvider: {
	reason: {type: "string", maxLength: 32}
	until:  _sofaInstant
}
// The provider's standing: a 401 or 403 pauses it until an operator resumes
// it, a 429 blocks it until the instant the refusal named. Admission asks it
// before admitting anything.
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
			blocked: on: lapsed: {guard: "isDue", target: "open", actions: "resume"}
			// A pause outranks a block, and a block outlives a lesser refusal.
			judged: always: [{guard: "isPaused", target: "paused"}, {guard: "isBlocked", target: "blocked"}, {target: "open"}]
		}
	}
	setup: {
		initialize: "initial"
		guards: {
			isDue: {reads: ["_time"], reason: "not_due"}
			isPaused: reads: []
			isBlocked: reads: []
		}
		actions: {
			refuse: {reads: ["status", "until"], writes: ["reason", "until"]}
			resume: {reads: [], writes: ["reason", "until"]}
		}
		version: 1
		types: {
			input: {type: "object", fields: {}}
			context: {type: "object", fields: _sofaProvider}
			view: {type: "object", fields: {_sofaProvider, phase: {type: "string", maxLength: 7, values: _sofaProviderPhases}}}
			events: {
				refused: {tier: "mecha", payload: {type: "object", fields: {
					status: {type: "integer", min: 0, max: 999}
					until:  _sofaInstant
				}}}
				resumed: {tier: "mecha", payload: {type: "object", fields: {}}}
				lapsed: {tier: "mecha", payload: {type: "object", fields: {}}}
			}
		}
		ports: wake: {phases: ["blocked"], deadline: "until", event: "lapsed"}
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
