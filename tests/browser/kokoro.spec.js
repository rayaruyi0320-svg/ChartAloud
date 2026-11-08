import { test, expect } from "@playwright/test";

test("bundled Kokoro voice synthesizes locally without remote model requests", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const assetResponses = [];
  const externalRequests = [];
  const pageErrors = [];
  await page.addInitScript(() => {
    window.browserSpeechCalls = 0;
    const browserSpeak = window.speechSynthesis.speak.bind(window.speechSynthesis);
    window.speechSynthesis.speak = (utterance) => {
      window.browserSpeechCalls++;
      return browserSpeak(utterance);
    };
  });
  page.on("response", (response) => {
    if (
      /\/models\/kokoro\/|\/voices\/af_heart\.bin$|\/wasm\/ort-wasm-simd-threaded\./.test(
        response.url(),
      )
    )
      assetResponses.push({ url: response.url(), status: response.status() });
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("https://huggingface.co/**", (route) => {
    externalRequests.push(route.request().url());
    return route.abort();
  });
  await page.goto("/");
  await page.getByRole("button", { name: /Creator Mode/ }).click();
  await page.locator("#file").setInputFiles({
    name: "voice-test.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("Category,Value\nA,5\nB,9"),
  });
  await page.getByLabel("No unit", { exact: true }).check();
  await page
    .getByRole("button", { name: "Validate mapping and continue" })
    .click();
  await page.getByRole("button", { name: "Preview as learner" }).click();
  await expect(page.locator(".learner-screen #explorer")).toBeVisible();
  await expect(
    page.getByRole("note", { name: "Keyboard shortcuts" }),
  ).toBeVisible();
  await expect(
    page.getByRole("note", { name: "Keyboard shortcuts" }),
  ).toContainText("Enter");
  await expect.poll(() => assetResponses.some(({ url }) =>
    url.includes("/models/kokoro/onnx/model_quantized.onnx")),
  { timeout: 120_000 }).toBe(true);
  await page.locator("#explorer").focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await expect(page.locator("[data-point]").first()).toBeFocused();
  await expect(page.locator("#player-status")).toHaveText(
    "Reading exact value.",
    { timeout: 120_000 },
  );
  await expect(page.locator("#player-status")).toHaveText("Ready to play.", {
    timeout: 120_000,
  });
  expect(assetResponses).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        url: expect.stringContaining("/models/kokoro/onnx/model_quantized.onnx"),
        status: 200,
      }),
      expect.objectContaining({
        url: expect.stringContaining("/voices/af_heart.bin"),
        status: 200,
      }),
      expect.objectContaining({
        url: expect.stringContaining("/wasm/ort-wasm-simd-threaded.wasm"),
        status: 200,
      }),
    ]),
  );
  expect(externalRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(await page.evaluate(() => window.browserSpeechCalls)).toBe(0);
});

test("original af_heart home greeting plays after audio is unlocked", async ({ page }) => {
  test.setTimeout(180_000);
  const voiceResponses = [];
  await page.addInitScript(() => {
    window.browserSpeechCalls = 0;
    window.speechSynthesis.speak = () => window.browserSpeechCalls++;
  });
  page.on("response", (response) => {
    if (response.url().endsWith("/voices/welcome-home.wav"))
      voiceResponses.push(response.status());
  });
  await page.goto("/");
  await expect(page.locator("#assistant-messages")).toContainText(
    "Welcome to ChartAloud",
  );
  await page.locator("h1").click();
  await expect.poll(() => voiceResponses.some((status) => [200, 206].includes(status)), {
    timeout: 120_000,
  }).toBe(true);
  await expect(page.locator(".voice-assistant")).toHaveClass(/is-speaking/, {
    timeout: 120_000,
  });
  expect(await page.evaluate(() => window.browserSpeechCalls)).toBe(0);
});
