import { type SubmitAccessRequest } from "wasp/server/operations";
import { emailSender } from "wasp/server/email";
import * as z from "zod";

const schema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  whyNeedButler: z.string().min(1),
  urgency: z.string().min(1),
  budget: z.string().min(1),
});

export const submitAccessRequest: SubmitAccessRequest<
  { name: string; email: string; whyNeedButler: string; urgency: string; budget: string },
  void
> = async (args, _context) => {
  const data = schema.parse(args);

  await emailSender.send({
    to: "access@alfred.black",
    subject: `New access request: ${data.name}`,
    text: `
New Alfred Black access request

Name: ${data.name}
Email: ${data.email}
Why they need a butler: ${data.whyNeedButler}
Urgency: ${data.urgency}
Monthly budget: ${data.budget}
    `.trim(),
    html: `
<h2>New Alfred Black Access Request</h2>
<p><strong>Name:</strong> ${data.name}</p>
<p><strong>Email:</strong> ${data.email}</p>
<p><strong>Why they need a butler:</strong> ${data.whyNeedButler}</p>
<p><strong>Urgency:</strong> ${data.urgency}</p>
<p><strong>Monthly budget:</strong> ${data.budget}</p>
    `.trim(),
  });
};
