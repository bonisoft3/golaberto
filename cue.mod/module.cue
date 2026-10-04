// Mirror-only module declaration. Copybara stages this file from
// .mirror/cue.mod/ to the bonisoft3/golaberto root as
// cue.mod/module.cue. In the monorepo golaberto's CUE resolves against the
// root cue.mod (bonisoft.org), which is HEAD; copybara rewrites its imports
// to github.com/bonisoft3/*, and the mirror resolves them from the Central
// Registry at the versions below, the ones .mise.toml installs.
module: "github.com/bonisoft3/golaberto@v0"

language: {
	version: "v0.16.1"
}

source: {
	kind: "git"
}

deps: {
	"github.com/bonisoft3/bayt@v0": {
		v:       "v0.58.2"
		default: true
	}
	"github.com/bonisoft3/mecha@v0": {
		v:       "v0.4.0"
		default: true
	}
	"github.com/bonisoft3/omnishell@v0": {
		v:       "v0.5.0"
		default: true
	}
	"github.com/bonisoft3/pronto@v0": {
		v:       "v0.6.0"
		default: true
	}
	"github.com/bonisoft3/sayt@v0": {
		v:       "v0.42.0"
		default: true
	}
}
