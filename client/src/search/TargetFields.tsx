import type { Targets } from "../types";
import styles from "../App.module.css";

export interface TargetInputProps {
    targetInputs: { minProfit: string; minRoi: string };
    changeTarget: (field: keyof Targets, text: string) => void;
}

// Quick picks in each target's dropdown: [box text, label]. Empty is Any.
const TARGET_PRESETS: Record<"minProfit" | "minRoi", [string, string][]> = {
    minProfit: [["", "Any"], ["25", "$25"], ["50", "$50"], ["100", "$100"], ["200", "$200"]],
    minRoi: [["", "Any"], ["10", "10%"], ["25", "25%"], ["50", "50%"], ["100", "100%"]],
};

export function TargetMenu({ field, close, targetInputs, changeTarget }: TargetInputProps & { field: keyof Targets; close: () => void }) {
    return (
        <div className={styles.targetMenu}>
            <div className={styles.presets}>
                {TARGET_PRESETS[field].map(([text, label]) => (
                    <button
                        key={label}
                        type="button"
                        aria-pressed={targetInputs[field] === text}
                        onClick={() => {
                            changeTarget(field, text);
                            close();
                        }}
                    >
                        {label}
                    </button>
                ))}
            </div>
            <label className={styles.field}>
                <span>Custom</span>
                <span className={styles.affix}>
                    {field === "minProfit" && <span>$</span>}
                    <input
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="5"
                        placeholder="Any"
                        value={targetInputs[field]}
                        onChange={(event) => changeTarget(field, event.target.value)}
                    />
                    {field === "minRoi" && <span>%</span>}
                </span>
            </label>
        </div>
    );
}

export function TargetFields({ targetInputs, changeTarget }: TargetInputProps) {
    return (
        <>
            <label className={styles.target} title="Minimum profit after every cost">
                {targetInputs.minProfit !== "" && <span>$</span>}
                <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="5"
                    placeholder="Any"
                    value={targetInputs.minProfit}
                    onChange={(event) => changeTarget("minProfit", event.target.value)}
                    aria-label="Minimum profit, dollars"
                />
                <span>profit</span>
            </label>
            <label className={styles.target} title="Minimum return on everything you put in">
                <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="5"
                    placeholder="Any"
                    value={targetInputs.minRoi}
                    onChange={(event) => changeTarget("minRoi", event.target.value)}
                    aria-label="Minimum return, percent"
                />
                <span>{targetInputs.minRoi === "" ? "ROI" : "% ROI"}</span>
            </label>
        </>
    );
}
