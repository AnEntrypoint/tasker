import { google } from "npm:googleapis";
import { join } from "https://deno.land/std@0.224.0/path/mod.ts";

export const sendEmail = async (recipientEmail, subject, body) => {
  try {
    const keyFile = join(".", "service-account-key.json");
    const keys = JSON.parse(await Deno.readTextFile(keyFile));

    const jwtClient = new google.auth.JWT(
      keys.client_email,
      undefined,
      keys.private_key,
      ["https://www.googleapis.com/auth/gmail.send"],
      "noreply@coas.co.za"
    );

    await jwtClient.authorize();

    const gmail = google.gmail({ version: "v1", auth: jwtClient });

    const rawEmail = [
      `To: ${recipientEmail}`,
      `Subject: ${subject}`,
      `From: noreply@coas.co.za`,
      "",
      body,
    ].join("\n");

    const base64Email = btoa(rawEmail)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    await gmail.users.messages.send({
      userId: "me",
      resource: { raw: base64Email },
    });
  } catch (error) {
    console.error("Error during email sending process:", error);
  }
};