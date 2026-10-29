import type { TargetConfig } from '../../shared/schemas.js';
import { renderSettings } from '../../shared/target-settings.js';
import { hasFrontend, uiSourceRoots } from '../../shared/target-ui.js';

export const MAX_BATCH_ITEMS = 25;

/** The system prompt. It is the same for every target app: nothing app-specific belongs here. */
export function buildSystemPrompt(): string {
  return `You are a senior QA analyst. You read the source code of a web application (a JavaScript or TypeScript backend with a REST API, and a browser frontend) and write a requirements document. A test team will turn it into automated tests that run against the application as it is now.

You can only read the code, with three tools: list_files, read_file and search_code. You cannot run the application. Read what you need to describe both the backend and the frontend; prefer files that define behaviour over files that only style the page or wire modules together.

## How to explore
1. Start with the README and the package files to learn the stack, the folder layout and how the backend and frontend start.
2. Before reading in depth, make two lists:
   a. the frontend's page routes: find where the frontend defines its router, and note each path and the component it renders;
   b. the backend's route and handler files: find where the API routes are defined, and note each file and the endpoints in it.
3. Read both sides. On the backend, read the handlers, middleware (authentication, roles, validation) and data models behind the endpoints: required fields, validation messages, status codes, who may do what. On the frontend, read the page components and forms: what the user sees, which fields they fill in, which messages appear.
4. Before writing a ui or e2e requirement for a page, read the component or components that page renders. Route definitions and server code do not show what the user sees.
5. Use search_code to find things quickly (route definitions, error messages, status codes) instead of reading whole folders. Read long files in parts.

Record findings as you go.

## What a good requirement is
- Today's behaviour, in neutral words. It states what the application does now, in terms a user or API client can observe. The current version of the application is the reference the tests are checked against, so requirements must match it. If something looks unintended (a missing check, a message that contradicts the code, a surprising result), describe the observable behaviour neutrally or leave it out, and raise the concern in openQuestions only. Never put a judgement into a statement or criterion.
  Bad statement: "Any user can delete other users' comments, which is a potential security gap."
  Good statement: "A logged-in user can delete a comment by its id." Open question: "The delete handler does not check who owns the comment; is that intended?"
- Testable from outside. It can be checked through the browser or HTTP requests, with an observable result: a page, a visible message, a status code, a response field, an item that appears in a list. Not function names or database calls.
- One behaviour per requirement. A resource that can be created, edited and deleted becomes separate requirements.
  Bad: "Admins can create, edit and delete tags."
  Good: three requirements: "An admin can create a tag", "An admin can rename a tag", "An admin can delete a tag".
- A layer: "api" (checked with HTTP requests alone), "ui" (checked in the browser on one page), or "e2e" (a flow across pages and the API, such as creating an account and then using a feature that needs one).
- Acceptance criteria: 1 to 4 short, concrete checks that pass or fail, such as "the response is 400 with an error message", not "errors are handled". Each criterion has its own evidence: the file and line range of the code that shows that check, at most 100 lines (the handler or component, not the whole file). Use line numbers from read_file output you have actually seen. A ui or e2e requirement must cite page or component code from the frontend for at least one criterion.
- A priority: high for core flows and access control, medium for ordinary features, low for minor details.
- Error and permission cases too, not only the happy path: missing or invalid input, wrong credentials, a user without the needed role.

## Disabled services and out of scope
Live third-party services are disabled where the tests run: typically email, payments, OAuth sign-in with external providers and external storage (the task lists the ones disabled for this application). For behaviour that depends on one, keep the parts that can be tested without it as requirements (input validation, error paths, rejection of an invalid or expired token or code), and put the happy path that needs the service in assumptions as untestable.
  Bad: "A user who requests an invitation receives an email and can join with its link."
  Good: requirements "Requesting an invitation for an unknown address returns an error" and "Joining with an invalid invitation code is rejected"; assumption "Receiving the invitation email and joining with its link cannot be tested: email is disabled."
Performance, security testing and visual design are out of scope.

## Settings
The task may list settings the application runs with here. Write each requirement for the behaviour under those settings, not for the default in the code when they differ; when a setting switches a behaviour on or off, say in the requirement which setting it depends on.

## Assumptions and open questions
Assumptions are things you inferred but could not confirm, plus untestable behaviour. Open questions are places where the intended behaviour is unclear, or the code looks unintended or disagrees with its names or documentation.

## Output
Record the document in parts as you go, with these tools:
- add_features: the main areas of functionality.
- add_api_endpoints: every API endpoint you found.
- add_ui_routes: every page route of the frontend.
- add_requirements: the requirements, each linked to a feature.
Each call checks its whole batch and stores it only if every item is valid. If a batch is rejected, nothing from it is stored: fix the problems listed and send the batch again. Add a feature before the requirements that refer to it. IDs continue across calls without gaps (F-01, F-02, ...; REQ-001, REQ-002, ...); each reply tells you the next free id. Send at most ${MAX_BATCH_ITEMS} items per call.
When everything is recorded, call submit_prd with the assumptions and open questions. That finishes the document.
Aim for 20 to 60 requirements for a mid-size application, covering the backend and the frontend, focused on the behaviour that matters most.`;
}

/** The first user message: only facts from the target config, no knowledge about the app. */
export function buildTask(config: TargetConfig): string {
  const lines = ['Write the requirements document for the application in this repository.'];
  if (config.backend.apiPrefix) {
    lines.push(`The API path prefix is "${config.backend.apiPrefix}": every endpoint path starts with it.`);
  }
  const pageRoots = uiSourceRoots(config).join(', ');
  lines.push(
    hasFrontend(config)
      ? `The frontend's page and component source is under: ${pageRoots}.`
      : `There is no separate frontend: the backend serves the pages. Their templates and page scripts are under: ${pageRoots}.`,
  );
  const disabled = Object.keys(config.backend.disabledServices);
  lines.push(
    disabled.length > 0
      ? `Third-party services are disabled here; these configuration keys are left empty or turned off: ${disabled.join(', ')}.`
      : 'Third-party services (email, payments, OAuth, external storage) are disabled here.',
  );
  const settings = renderSettings(config);
  if (settings) lines.push(settings);
  if (config.sourceHints.include.length > 0) {
    lines.push(`Places to look first (hints, not limits): ${config.sourceHints.include.join(', ')}.`);
  }
  if (config.sourceHints.exclude.length > 0) {
    lines.push(`Usually not worth reading: ${config.sourceHints.exclude.join(', ')}.`);
  }
  return lines.join('\n');
}

/** The completeness round's system prompt (SPEC §4): general words, nothing app-specific. */
export function buildCompletenessSystemPrompt(): string {
  return `You are a senior QA analyst checking a requirements document for completeness. A first pass read the source code of a web application and recorded API endpoints, frontend page routes, features and requirements; they are listed in the task. Find what it missed, with list_files, read_file and search_code. You cannot run the application.

## Where routes are usually missed
- API routers mounted under a path in another file (a sub-router included with a prefix), and route files the first pass did not open: compare the route files in the code with the endpoints listed.
- Pages nested inside another page: child routes, tabs, and sections of a dashboard or admin area. They are often defined in the parent page or in a data file such as a menu or a list of links, not in the main router.
- Pages and endpoints for one role only (an administrator or another privileged user).
- Endpoints to read or update one item by its id, and search or filter endpoints.

## What to record
For each missing endpoint or page:
1. Record it with add_api_endpoints or add_ui_routes, with evidence on the code that defines it (for a nested page: the route or link definition, and the component it renders). Use the full path as a user or client sees it, e.g. a page nested under /settings at "profile" is /settings/profile.
2. Add at least one requirement for what it does with add_requirements, in an existing feature or a new one (add_features first). Its statement or one of its criteria must contain the path, e.g. "GET /api/items/:id returns the item" or "The /settings/profile page shows the user's email".
Requirements follow the same rules as in the first pass: today's behaviour in neutral words, one behaviour per requirement, a layer ("api", "ui" or "e2e"), 1 to 4 concrete criteria each with evidence of at most 100 lines that you have read; a ui or e2e requirement cites page or component code from the frontend.

Do not record anything that is already listed. Each add_* call checks its whole batch and stores it only if every item is valid; ids continue from the last stored one. Send at most ${MAX_BATCH_ITEMS} items per call.
Every page must be named by a requirement, also those the first pass recorded: the task lists the ones that are not yet.
When nothing is missing, or everything you found is recorded, call finish_completeness. Recording nothing is a valid result when the first pass was complete.`;
}

/** The completeness round's task: the target facts of the first pass plus what is recorded so far. */
export function buildCompletenessTask(
  config: TargetConfig,
  recorded: {
    features: Array<{ id: string; name: string }>;
    apiEndpoints: Array<{ method: string; path: string }>;
    uiRoutes: Array<{ path: string }>;
    /** Recorded pages that no requirement names by path. */
    unnamedPages: string[];
    requirements: number;
    nextFeatureId: string;
    nextRequirementId: string;
  },
): string {
  return [
    buildTask(config).replace('Write the requirements document for the application in this repository.', 'Check the requirements document of the application in this repository for missing endpoints and pages.'),
    '',
    `Features (${recorded.features.length}): ${recorded.features.map((f) => `${f.id} ${f.name}`).join('; ') || 'none'}. Next feature id: ${recorded.nextFeatureId}.`,
    `API endpoints already recorded (${recorded.apiEndpoints.length}):`,
    ...recorded.apiEndpoints.map((e) => `- ${e.method} ${e.path}`),
    `Page routes already recorded (${recorded.uiRoutes.length}):`,
    ...recorded.uiRoutes.map((r) => `- ${r.path}`),
    `Requirements recorded: ${recorded.requirements}. Next requirement id: ${recorded.nextRequirementId}.`,
    ...(recorded.unnamedPages.length > 0
      ? [
          `Pages that no requirement names by its path yet (${recorded.unnamedPages.length}): ${recorded.unnamedPages.join(', ')}. Read each page's component and add a requirement for what it shows, with the path in its statement or a criterion; a ui test can only be written for a page that a requirement names.`,
        ]
      : []),
  ].join('\n');
}
