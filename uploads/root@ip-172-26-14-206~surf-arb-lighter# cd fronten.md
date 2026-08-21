root@ip-172-26-14-206:~/surf-arb-lighter# cd frontend && bun install && BASE_PATH=/ bun run build
[0.04ms] ".env"
bun install v1.4.0 (34cbb9a40)

Checked 306 installs across 365 packages (no changes) [18.00ms]
$ node scripts/check-env.cjs bun run build:client && bun run build:server
$ vite build --outDir dist/client
✘ [ERROR] Could not resolve "./.vulcan-error-reporter.js"

    vite.config.ts:1:301:
      1 │ ...al_import_meta_url = "file:///root/surf-arb-lighter/frontend/vite.config.ts";import viteErrorReporter from "./.vulcan-error-reporter.js";
        ╵                                                                                                               ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

failed to load config from /root/surf-arb-lighter/frontend/vite.config.ts
error during build:
Error: Build failed with 1 error:
vite.config.ts:1:301: ERROR: Could not resolve "./.vulcan-error-reporter.js"
    at failureErrorWithLog (/root/surf-arb-lighter/frontend/node_modules/esbuild/lib/main.js:1467:19)
    at <anonymous> (/root/surf-arb-lighter/frontend/node_modules/esbuild/lib/main.js:926:25)
    at buildResponseToResult (/root/surf-arb-lighter/frontend/node_modules/esbuild/lib/main.js:924:7)
    at <anonymous> (/root/surf-arb-lighter/frontend/node_modules/esbuild/lib/main.js:603:9)
    at handleIncomingPacket (/root/surf-arb-lighter/frontend/node_modules/esbuild/lib/main.js:658:12)
    at readFromStdout (/root/surf-arb-lighter/frontend/node_modules/esbuild/lib/main.js:581:7)
    at emit (node:events:100:22)
    at addChunk (internal:streams/readable:267:47)
    at readableAddChunkPushByteMode (internal:streams/readable:245:18)
    at pushAndCheck (internal:streams/native-readable:66:19)
error: script "build:client" exited with code 1
error: script "build" exited with code 1