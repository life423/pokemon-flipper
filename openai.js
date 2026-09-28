import OpenAI from "openai";
import fs from "node:fs";

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

export async function testOpenAI() {
    const response = await openai.responses.create({
        model: "gpt-5.6-luna",
        input: "Reply with exactly: OpenAI connection works",
    });

    return response.output_text;
}

export async function testImageAnalysis() {
    const imageBuffer = fs.readFileSync(
        "./public/images/charizard-front.png"
    );

    const base64Image = imageBuffer.toString("base64");

    const response = await openai.responses.create({
        model: "gpt-5.6-luna",

        input: [
            {
                role: "user",
                content: [
                    {
                        type: "input_text",
                        text: "Describe what is shown in this image.",
                    },
                    {
                        type: "input_image",
                        image_url: `data:image/png;base64,${base64Image}`,
                    },
                ],
            },
        ],
    });

    return response.output_text;
}
