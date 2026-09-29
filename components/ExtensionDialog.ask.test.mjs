import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

// React only ships `act` in its development build; force NODE_ENV before any
// React module is loaded so these tests work regardless of the environment's
// default (production builds throw "act(...) is not supported").
process.env.NODE_ENV = "test";
const React = (await import("react")).default;
const { cleanup, fireEvent, render, screen } = await import("@testing-library/react/pure.js");
const { createJiti } = await import("jiti");

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { ExtensionDialog } = await jiti.import("./ExtensionDialog.tsx");

afterEach(cleanup);

const color = {
  id: "color",
  question: "Pick a color",
  header: "Color",
  options: [{ label: "Red" }, { label: "Green", description: "Calm" }, { label: "Blue" }],
  recommended: 1,
};
const size = { id: "size", question: "Pick a size", options: [{ label: "S" }, { label: "M" }] };
const extras = {
  id: "extras",
  question: "Extras?",
  multi: true,
  options: [{ label: "Cheese" }, { label: "Ham" }, { label: "Egg" }],
  recommended: 2,
};

function renderAsk(questions) {
  const responses = [];
  render(React.createElement(ExtensionDialog, {
    request: { type: "extension_ui_request", id: "ask-1", method: "ask", questions },
    onRespond: (_request, response) => responses.push(response),
    attached: true,
  }));
  return responses;
}

test("single-select renders radios with the recommended option marked and preselected; multi renders checkboxes", () => {
  renderAsk([color, extras]);
  const colorGroup = screen.getByRole("group", { name: /Pick a color/ });
  const radios = colorGroup.querySelectorAll('input[type="radio"]');
  assert.equal(radios.length, 3);
  assert.equal(colorGroup.querySelectorAll('input[type="checkbox"]').length, 0);
  assert.equal(screen.getByRole("radio", { name: /Green/ }).checked, true);
  assert.match(screen.getByRole("radio", { name: /Green/ }).closest("label").textContent, /Recommended/);
  assert.equal(screen.getByRole("radio", { name: /Red/ }).checked, false);

  const extrasGroup = screen.getByRole("group", { name: /Extras\?/ });
  assert.equal(extrasGroup.querySelectorAll('input[type="checkbox"]').length, 3);
  assert.equal(extrasGroup.querySelectorAll('input[type="radio"]').length, 0);
  // Multi-select marks its recommendation but does not preselect it.
  assert.match(screen.getByRole("checkbox", { name: /Egg/ }).closest("label").textContent, /Recommended/);
  assert.equal(screen.getByRole("checkbox", { name: /Egg/ }).checked, false);
});

test("Submit stays disabled until every single-select question is answered", async () => {
  const responses = renderAsk([color, size, extras]);
  const submit = screen.getByRole("button", { name: "Submit" });
  assert.equal(submit.disabled, true, "size has no recommendation and no answer yet");
  fireEvent.click(submit);
  assert.deepEqual(responses, []);

  const sizeOther = screen.getByRole("group", { name: /Pick a size/ }).querySelector("textarea");
  fireEvent.change(sizeOther, { target: { value: "   " } });
  assert.equal(submit.disabled, true, "blank Other is not an answer");
  fireEvent.change(sizeOther, { target: { value: "" } });
  fireEvent.click(screen.getByRole("radio", { name: "M" }));
  assert.equal(submit.disabled, false, "empty multi-select does not block submit");
});

test("submit sends answers in question order: single choice, multi choices in option order, trimmed Other", async () => {
  const responses = renderAsk([color, extras, size]);
  fireEvent.click(screen.getByRole("checkbox", { name: /Egg/ }));
  fireEvent.click(screen.getByRole("checkbox", { name: /Cheese/ }));
  fireEvent.change(screen.getByRole("group", { name: /Extras\?/ }).querySelector("textarea"), { target: { value: "  pickles  " } });
  fireEvent.click(screen.getByRole("radio", { name: "S" }));
  fireEvent.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(responses, [{
    answers: [
      { id: "color", selectedOptions: ["Green"] },
      { id: "extras", selectedOptions: ["Cheese", "Egg"], customInput: "pickles" },
      { id: "size", selectedOptions: ["S"] },
    ],
  }]);
});

test("single-select Other replaces the radio choice, and picking a radio clears Other", async () => {
  const responses = renderAsk([color]);
  const other = screen.getByRole("group", { name: /Pick a color/ }).querySelector("textarea");
  fireEvent.change(other, { target: { value: " Teal " } });
  assert.equal(screen.getByRole("radio", { name: /Green/ }).checked, false);
  fireEvent.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(responses.pop(), { answers: [{ id: "color", selectedOptions: [], customInput: "Teal" }] });

  fireEvent.click(screen.getByRole("radio", { name: "Red" }));
  assert.equal(other.value, "");
  fireEvent.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(responses.pop(), { answers: [{ id: "color", selectedOptions: ["Red"] }] });
});

test("Cancel answers cancelled", async () => {
  const responses = renderAsk([color]);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  assert.deepEqual(responses, [{ cancelled: true }]);
});
