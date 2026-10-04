package prontoproject

import "github.com/bonisoft3/pronto/distribution"

pronto: distribution.#Project
// The monorepo's .bayt/.env says to build mecha's images from its sources;
// absent here, compose and mise pull the pinned ones.
pronto: mise: env: "_": file: ".bayt/.env"
