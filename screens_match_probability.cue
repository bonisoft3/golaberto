package golaberto

import "encoding/json"

_matchProbabilityAddGoal: {
	guard: {type: "match-probability-event-control", params: operation: "can-add"}
	assign: {
		next_event_id: {type: "match-probability-event-control", params: operation: "next-id"}
		event_sequence: {type: "match-probability-event-control", params: operation: "next-sequence"}
		event_count: {type: "match-probability-event-control", params: operation: "next-count"}
	}
	effect: {
		level:  "ephemeral"
		op:     "create"
		entity: "match_probability_scenario_event"
		values: {
			id:   "{next_event_id}", game_id: "{id}", state:  "ready", sequence: "{event_sequence}"
			kind: "goal", side:               "home", minute: 0
		}
	}
}

_matchProbabilityAddRedCard: {
	guard: {type: "match-probability-event-control", params: operation: "can-add"}
	assign: {
		next_event_id: {type: "match-probability-event-control", params: operation: "next-id"}
		event_sequence: {type: "match-probability-event-control", params: operation: "next-sequence"}
		event_count: {type: "match-probability-event-control", params: operation: "next-count"}
	}
	effect: {
		level:  "ephemeral"
		op:     "create"
		entity: "match_probability_scenario_event"
		values: {
			id:   "{next_event_id}", game_id: "{id}", state:  "ready", sequence: "{event_sequence}"
			kind: "red_card", side:           "home", minute: 0
		}
	}
}

_matchProbabilityMachine: json.Marshal({
	field:   "state"
	initial: "ready"
	context: {
		minute:      "0", added_time: "5", event_sequence: 0, next_event_id: ""
		event_count: 0, events_json:  "[]", payload_json: "", home_name: "", away_name: ""
	}
	states: ready: on: {
		"input@match-probability-minute": {assign: minute: {type: "event", params: field: "value"}}
		"input@match-probability-added": {assign: added_time: {type: "event", params: field: "value"}}
		"click@match-probability-add-goal":     _matchProbabilityAddGoal
		"click@match-probability-add-red-card": _matchProbabilityAddRedCard
	}
})

_matchProbabilityEventMachine: json.Marshal({
	field:   "state"
	initial: "ready"
	context: {side: "home", minute: 0}
	states: ready: on: {
		input: assign: {
			side: {type: "match-probability-event-edit", params: field: "side"}
			minute: {type: "match-probability-event-edit", params: field: "minute"}
		}
		click: {
			guard: {type: "match-probability-event-edit", params: field: "remove"}
			effect: {
				level: "ephemeral", op: "delete", entity: "match_probability_scenario_event"
				values: id: "{id}"
			}
		}
	}
})

_matchProbabilityEmpty: json.Marshal({
	id:             "{id}", state:    "ready", minute: "0", added_time: "5"
	event_sequence: 0, next_event_id: "", event_count: 0, events_json:  "[]"
	payload_json: "", home_name: "", away_name: ""
})

_matchProbabilityMarkup: """
	<section class="match-probability-shell" aria-labelledby="match-probability-{id}">
	 <h2 id="match-probability-{id}" data-text="{msg.match_probability_title}"></h2>
	 <div data-live="match_probability_scenario" data-filter="id=eq.{id}" data-machine='\(_matchProbabilityMachine)' data-empty-row='\(_matchProbabilityEmpty)' data-on-mutation="match-probability-seed" data-read-stored="match_probability_scenario?id=eq.{id}" data-read-source="match_probability?id=eq.{id}&limit=1">
	  <fieldset class="match-probability-controls"><legend data-text="{msg.match_probability_scenario}"></legend>
	   <div class="match-probability-control-grid">
	    <label><span data-text="{msg.match_probability_minute}"></span><input id="match-probability-minute" type="number" min="0" max="130" step="1" value="{minute}"></label>
	    <label><span data-text="{msg.match_probability_added_time}"></span><input id="match-probability-added" type="number" min="0" max="40" step="1" value="{added_time}"></label>
	   </div>
	   <div class="match-probability-event-actions">
	    <button id="match-probability-add-goal" type="button" class="btn-quiet" data-text="{msg.match_probability_add_goal}"></button>
	    <button id="match-probability-add-red-card" type="button" class="btn-quiet" data-text="{msg.match_probability_add_red_card}"></button>
	   </div>
	   <div class="match-probability-events" data-live="match_probability_scenario_event" data-filter="game_id=eq.{id}&limit=21" data-order="sequence.asc" data-empty="{msg.match_probability_events_empty}" data-on-mutation="match-probability-event-fold" data-read-view="match_probability_scenario?id=eq.{id}">
	    <template data-item><div class="match-probability-event-row">
	     <div data-live="match_probability_scenario_event" data-filter="id=eq.{id}" data-machine='\(_matchProbabilityEventMachine)'>
	      <template data-item><div class="match-probability-event match-probability-event--{kind}">
	       <span class="match-probability-event__kind match-probability-event__kind--goal" data-text="{msg.match_probability_event_goal}"></span>
	       <span class="match-probability-event__kind match-probability-event__kind--red-card" data-text="{msg.match_probability_event_red_card}"></span>
	       <label><span data-text="{msg.match_probability_event_side}"></span><select id="{id}-side" data-value="{side}"><option value="home" data-text="{msg.match_probability_home_side}"></option><option value="away" data-text="{msg.match_probability_away_side}"></option></select></label>
	       <label><span data-text="{msg.match_probability_event_time}"></span><input id="{id}-minute" type="number" min="0" max="130" step="1" value="{minute}"></label>
	       <button id="{id}-remove" type="button" class="btn-quiet match-probability-event__remove" data-text="{msg.match_probability_remove_event}"></button>
	      </div></template>
	     </div>
	    </div>
	    </template>
	   </div>
	   <p class="hint" data-text="{msg.match_probability_scenario_hint}"></p>
	  </fieldset>
	  <div class="match-probability-source" data-live="match_probability" data-filter="id=eq.{id}&limit=1" data-empty="{msg.match_probability_no_data}"><template data-item><span hidden></span></template></div>
	  <div data-text="{payload_json}\u001f{minute}\u001f{added_time}\u001f{events_json}\u001f{home_name}\u001f{away_name}\u001f{msg.match_probability_draw}\u001f{msg.match_probability_prematch}\u001f{msg.match_probability_rated_on}\u001f{msg.match_probability_timeline}\u001f{msg.match_probability_missing_rating}\u001f{msg.match_probability_ambiguous_rating}\u001f{msg.match_probability_unknown_minute}\u001f{msg.match_probability_event_limit}\u001f{msg.match_probability_invalid_scenario}\u001f{msg.chart_locale}\u001f{msg.match_probability_minute}" data-text-format="match-probability"></div>
	 </div>
	</section>
	"""
