# An uninstalled credential helper must not prevent public image pulls.
# Scope the fallback to this invocation; never rewrite the user's config.
export def with-working-docker-config [action: closure] {
	let original = ($env.DOCKER_CONFIG? | default ($env.HOME | path join ".docker"))
	let file = ($original | path join "config.json")
	if not ($file | path exists) { return (do $action) }
	let config = (open $file)
	let store = ($config | get -o credsStore | default "")
	if ($store | is-empty) or (which $"docker-credential-($store)" | is-not-empty) {
		return (do $action)
	}

	print -e $"Docker credential helper '($store)' is unavailable; using a temporary config for this launch."
	let temporary = (mktemp -d)
	try {
		if $nu.os-info.name != "windows" { ^chmod 700 $temporary }
		$config | reject credsStore | to json | save ($temporary | path join "config.json")
		if $nu.os-info.name != "windows" { ^chmod 600 ($temporary | path join "config.json") }
		# Preserve context selection, locally installed plugins and builders.
		for name in [contexts cli-plugins buildx] {
			let source = ($original | path join $name)
			if ($source | path exists) { cp -r $source ($temporary | path join $name) }
		}
		let result = (with-env {DOCKER_CONFIG: $temporary} { do $action })
		rm -rf $temporary
		$result
	} catch { |err|
		rm -rf $temporary
		error make {msg: $err.msg}
	}
}
