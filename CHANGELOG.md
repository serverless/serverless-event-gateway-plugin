
0.2.0 / 2018-03-07
==================

BACKWARDS INCOMPATIBILITIES:

  * Changed `apikey` to `apiKey` in `serverles.yml` config.
  * `serverless emitremote` changed to `serverless gateway emit`

IMPROVEMENTS:

  * Add `serverless gateway dashboard` command to view space configuration.
  * bump SDK version (#22)
  * Add options to specify URL endpoints

0.1.0 / 2018-02-21
==================

IMPROVEMENTS:

  * add standard codestyle
  * bump SDK version (#22)
  * refactor plugin so it'll create/delete only what's needed (#21)
  * Rename .travis.yaml to .travis.yml
  * Add Travis config (#20)
  * Limit invokeFunction access to functions in service (#19)
