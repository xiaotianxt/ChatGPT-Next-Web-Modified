import { createParser } from "eventsource-parser";
import { NextRequest } from "next/server";
import { requestOpenai } from "../common";
import { getServerSideConfig } from "@/app/config/server";

class TokenStat {
  private counter = 0;
  constructor(private accessCode: string, private type: string) {}

  public add(value: number) {
    this.counter += value;
  }

  public async finish() {
    // print the result
    const { statUrl } = getServerSideConfig();
    if (statUrl) {
      const data = {
        amount: this.counter,
        code: this.accessCode,
        type: this.type,
      };
      fetch(statUrl + "/api/entry", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(data),
      })
        .then((res) => res.json())
        .then(console.log);
    }
  }
}

async function createStream(req: NextRequest) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  (async function stat() {
    const reqStat = new TokenStat(req.headers.get("access-code") ?? "", "req");

    const json = await req.clone().json();
    json.messages.forEach((cur: any) => {
      reqStat.add(cur?.content?.length || 0);
    });

    reqStat.finish();
  })();

  const res = await requestOpenai(req);
  const resStat = new TokenStat(req.headers.get("access-code") ?? "", "res");

  const contentType = res.headers.get("Content-Type") ?? "";
  if (!contentType.includes("stream")) {
    const content = await (
      await res.text()
    ).replace(/provided:.*. You/, "provided: ***. You");
    console.log("[Stream] error ", content);
    return "```json\n" + content + "```";
  }

  const stream = new ReadableStream({
    async start(controller) {
      function onParse(event: any) {
        if (event.type === "event") {
          const data = event.data;
          // https://beta.openai.com/docs/api-reference/completions/create#completions/create-stream
          if (data === "[DONE]") {
            controller.close();
            resStat.finish();
            return;
          }
          try {
            const json = JSON.parse(data);
            const text = json.choices[0].delta.content;
            const queue = encoder.encode(text);
            resStat.add(text?.length || 0);
            controller.enqueue(queue);
          } catch (e) {
            resStat.finish();
            controller.error(e);
          }
        }
      }

      const parser = createParser(onParse);
      for await (const chunk of res.body as any) {
        parser.feed(decoder.decode(chunk, { stream: true }));
      }
    },
  });
  return stream;
}

export async function POST(req: NextRequest) {
  try {
    const stream = await createStream(req);
    return new Response(stream);
  } catch (error) {
    console.error("[Chat Stream]", error);
    return new Response(
      ["```json\n", JSON.stringify(error, null, "  "), "\n```"].join(""),
    );
  }
}

export const runtime = "experimental-edge";
