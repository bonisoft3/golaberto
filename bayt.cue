package workspace

import (
	bayt "bonisoft.org/plugins/bayt/core:bayt"
	mise "bonisoft.org/plugins/bayt/stacks/mise"
	sayt "bonisoft.org/plugins/bayt/stacks/sayt"
)

// The app's generated setup inherits this shared workspace toolchain.
project: bayt.#project & {
	dir: ""
	activate: ""
	targets: setup: sayt.setup & mise.install & {
		visibility: "public"
		srcs: globs: ["[.]mise.toml", "[m]ise.lock", "cue.mod/**", "plugins/**", "libraries/**"]
		dockerfile: bayt.nubox
	}
}

depManifestsIn: {[string]: _}
_render: bayt.#render & {project: project, depManifests: depManifestsIn}
