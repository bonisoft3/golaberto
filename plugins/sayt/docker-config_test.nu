use std/assert
use docker-config.nu [with-working-docker-config]

def main [] {
	let fixture = (mktemp -d)
	let original = {credsStore: "sayt-missing-test-helper", currentContext: "test", auths: {}, cliPluginsExtraDirs: ["/test/plugins"]}
	$original | to json | save ($fixture | path join "config.json")
	mkdir ($fixture | path join contexts meta)
	"context metadata" | save ($fixture | path join contexts meta test)

	with-env {DOCKER_CONFIG: $fixture} {
		let temporary = (with-working-docker-config {
			let active = (open ($env.DOCKER_CONFIG | path join "config.json"))
			assert equal $active ($original | reject credsStore)
			assert equal (open --raw ($env.DOCKER_CONFIG | path join contexts meta test)) "context metadata"
			$env.DOCKER_CONFIG
		})
		assert not ($temporary | path exists)
		assert equal (open ($fixture | path join "config.json")) $original
		assert equal $env.DOCKER_CONFIG $fixture

		let failed = (try {
			with-working-docker-config {
				$env.DOCKER_CONFIG | save ($fixture | path join "failed-config-path")
				error make {msg: "intentional failure"}
			}
			false
		} catch { |err| $err.msg == "intentional failure" })
		assert $failed
		assert not (open --raw ($fixture | path join "failed-config-path") | path exists)
		assert equal (open ($fixture | path join "config.json")) $original

		$original | reject credsStore | to json | save -f ($fixture | path join "config.json")
		assert equal (with-working-docker-config { $env.DOCKER_CONFIG }) $fixture
	}
	rm -rf $fixture
	print "docker-config_test: all passed"
}
