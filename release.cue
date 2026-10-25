package golaberto

import (
	"github.com/bonisoft3/pronto/k8s/schema"
	"github.com/bonisoft3/pronto/k8s/envs"
)

// App defines the release specification for the golaberto web appliance.
App: schema.#ReleaseSpec & {
	name:      "golaberto"

	image: {
		tag:        "latest"
	}

	replicas: 1

	resources: {
		requests: {
			cpu:    "100m"
			memory: "256Mi"
		}
		limits: {
			cpu:    "1000m"
			memory: "1Gi"
		}
	}


	render: {
		enabled: true
	}

	gateway: {
		enabled: true
	}
}

// Manifest streams generated for each target environment
kindManifests: (schema.#BuildManifests & {release: App, env: envs.Kind}).manifests
eksManifests:  (schema.#BuildManifests & {release: App, env: envs.EKS}).manifests
aksManifests:  (schema.#BuildManifests & {release: App, env: envs.AKS}).manifests
