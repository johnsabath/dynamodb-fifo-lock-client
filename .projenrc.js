const { TypeScriptProject, ProjectType, github, tasks } = require('projen');

const LOCALSTACK_SERVICES = 'dynamodb';
const LOCALSTACK_CONTAINER_NAME = 'dynamodb-fifo-lock-client-localstack';

const project = new TypeScriptProject({
  name: 'dynamodb-fifo-lock-client',
  description: 'AWS DynamoDB distributed locking client with fencing tokens and FIFO acquisition queueing',
  projectType: ProjectType.LIB,
  defaultReleaseBranch: 'main',
  scripts: {
    'localstack:start': `docker run --name ${LOCALSTACK_CONTAINER_NAME} --rm -d -it -p 4566:4566 -p 4571:4571 -e SERVICES=${LOCALSTACK_SERVICES} -e LS_LOG=debug localstack/localstack`,
    'localstack:stop': `docker stop ${LOCALSTACK_CONTAINER_NAME}`,
  },
  peerDeps: ['aws-sdk@^2.857.0'],
  devDeps: ['wait-for-expect'],
  jestOptions: {
    jestConfig: {
      collectCoverage: true,
      setupFilesAfterEnv: ['<rootDir>/test/test-lifecycle/setupAfterEnv.ts'],
    },
  },
  releaseWorkflow: true,
  collectCoverage: true,
  codeCov: true,
  codeCovTokenSecret: 'CODECOV_TOKEN',
});

// Build project on CI pushes to "main" branch so that code coverage is updated
project.buildWorkflow.on({
  push: {
    branches: ['main'],
  },
  pull_request: {},
  workflow_dispatch: {},
});

// Update "test" task to spin-up localstack.
const localstackStartTask = project.tasks.tryFind('localstack:start');
const localstackStopTask = project.tasks.tryFind('localstack:stop');
project.testTask.env('AWS_ACCESS_KEY_ID', 'localkey');
project.testTask.env('AWS_SECRET_ACCESS_KEY', 'localsecret');
project.testTask.prependSpawn(localstackStartTask);
project.testTask.spawn(localstackStopTask);

project.synth();
