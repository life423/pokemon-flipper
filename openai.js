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
        "./public/images/charizard-front.jpg"
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
                        image_url: `data:image/jpeg;base64,${base64Image}`,
                    },
                ],
            },
        ],
    });

    return response.output_text;
}

export async function analyzeListingPhotos() {
    const frontImage = fs.readFileSync(
        "./public/images/charizard-front.jpg",
        "base64"
    );

    const backImage = fs.readFileSync(
        "./public/images/charizard-back.png",
        "base64"
    );

    const response = await openai.responses.create({
        model: "gpt-5.6-luna",

        input: [
            {
                role: "user",
                content: [
                    {
                        type: "input_text",
                        text: `
Listing title: 1999 Pokemon Charizard Holo #4

Evaluate ONLY whether these listing photos are sufficient
to assess the physical condition of the trading card.

Do not estimate a PSA grade yet.

Identify which useful card views are actually present,
which important views are missing, and any problems with
the photographic evidence.
                        `,
                    },
                    {
                        type: "input_image",
                        image_url:
                            `data:image/jpeg;base64,${frontImage}`,
                        detail: "high",
                    },
                    {
                        type: "input_image",
                        image_url:
                            `data:image/png;base64,${backImage}`,
                        detail: "high",
                    },
                ],
            },
        ],

        text: {
            format: {
                type: "json_schema",
                name: "photo_sufficiency",
                strict: true,

                schema: {
                    type: "object",

                    properties: {
                        photoSufficiency: {
                            type: "string",
                            enum: [
                                "SUFFICIENT",
                                "PARTIAL",
                                "INSUFFICIENT",
                            ],
                        },

                        confidence: {
                            type: "number",
                            minimum: 0,
                            maximum: 1,
                        },

                        usableViews: {
                            type: "array",
                            items: {
                                type: "string",
                            },
                        },

                        missingViews: {
                            type: "array",
                            items: {
                                type: "string",
                            },
                        },

                        problems: {
                            type: "array",
                            items: {
                                type: "string",
                            },
                        },
                    },

                    required: [
                        "photoSufficiency",
                        "confidence",
                        "usableViews",
                        "missingViews",
                        "problems",
                    ],

                    additionalProperties: false,
                },
            },
        },
    });

    return JSON.parse(response.output_text);
}

export async function estimateCardGrade(
    photoAnalysis,
    gradingMode
) {
    const frontImage = fs.readFileSync(
        "./public/images/charizard-front.jpg",
        "base64"
    );

    const backImage = fs.readFileSync(
        "./public/images/charizard-back.png",
        "base64"
    );

    const response = await openai.responses.create({
        model: "gpt-5.6-luna",

        input: [
            {
                role: "user",
                content: [
                    {
                        type: "input_text",
                        text: `
Listing title: 1999 Pokemon Charizard Holo #4

You are estimating a possible PSA-style grade range
from listing photographs.

This is NOT an official PSA grade.

Grading mode: ${gradingMode}

Previous photo analysis:
${JSON.stringify(photoAnalysis, null, 2)}

Rules:

- Use only defects actually visible in the photographs.
- Never assume an unseen area is defect-free.
- Do not treat a generic Pokémon card-back image as evidence
  of this specific card's back condition.
- Consider centering, corners, edges, surface, scratches,
  whitening, creases, dents, print defects, and holo wear
  only when visible.
- If evidence is incomplete, widen the grade range.

For LIMITED grading mode:

- Do not assume unseen areas are clean or damaged.
- Do not describe a grade as likely based on hypothetical
  condition of unseen areas.
- The grade range reflects only what the available evidence
  can support.
- Confidence must be LOW.
- In the summary, state that the missing evidence prevents
  a reliable single-grade prediction, instead of naming a
  likely grade that depends on the condition of unseen areas.

- lowGrade must be less than or equal to likelyGrade.
- likelyGrade must be less than or equal to highGrade.
- Grades must be integers from 1 through 10.
                        `,
                    },
                    {
                        type: "input_image",
                        image_url:
                            `data:image/jpeg;base64,${frontImage}`,
                        detail: "high",
                    },
                    {
                        type: "input_image",
                        image_url:
                            `data:image/png;base64,${backImage}`,
                        detail: "high",
                    },
                ],
            },
        ],

        text: {
            format: {
                type: "json_schema",
                name: "card_grade_estimate",
                strict: true,

                schema: {
                    type: "object",

                    properties: {
                        lowGrade: {
                            type: "integer",
                            minimum: 1,
                            maximum: 10,
                        },

                        likelyGrade: {
                            type: "integer",
                            minimum: 1,
                            maximum: 10,
                        },

                        highGrade: {
                            type: "integer",
                            minimum: 1,
                            maximum: 10,
                        },

                        confidence: {
                            type: "string",
                            enum: [
                                "LOW",
                                "MEDIUM",
                                "HIGH",
                            ],
                        },

                        visibleDefects: {
                            type: "array",
                            items: {
                                type: "string",
                            },
                        },

                        limitations: {
                            type: "array",
                            items: {
                                type: "string",
                            },
                        },

                        summary: {
                            type: "string",
                        },
                    },

                    required: [
                        "lowGrade",
                        "likelyGrade",
                        "highGrade",
                        "confidence",
                        "visibleDefects",
                        "limitations",
                        "summary",
                    ],

                    additionalProperties: false,
                },
            },
        },
    });

    return JSON.parse(response.output_text);
}
