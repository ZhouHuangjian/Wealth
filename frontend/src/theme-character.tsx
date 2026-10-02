import type { ThemeName } from "./theme";

/** Small, native vector characters; decorative details never overlap financial content. */
export function ThemeCharacter({
  name,
  className = "",
}: {
  name: ThemeName;
  className?: string;
}) {
  return name === "day" ? (
    <svg
      viewBox="0 0 100 80"
      className={`theme-character ${className}`}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M31 28C21 18 13 24 8 41C4 53 2 63 9 65C16 67 24 52 30 41M69 28C79 18 87 24 92 41C96 53 98 63 91 65C84 67 76 52 70 41"
        fill="#fff"
        stroke="#a8d4ef"
        strokeWidth="2.2"
      />
      <path
        d="M27 39C26 19 74 19 73 39C76 55 68 66 51 66C32 66 23 55 27 39Z"
        fill="#fff"
        stroke="#a8d4ef"
        strokeWidth="2.2"
      />
      <path
        d="M40 24C37 14 48 14 49 21C53 13 62 17 58 24"
        fill="#fff"
        stroke="#a8d4ef"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <ellipse cx="37" cy="43" rx="3.1" ry="4.4" fill="#3c8fc5" />
      <ellipse cx="63" cy="43" rx="3.1" ry="4.4" fill="#3c8fc5" />
      <ellipse cx="31" cy="51" rx="5" ry="2.8" fill="#f6cadc" />
      <ellipse cx="69" cy="51" rx="5" ry="2.8" fill="#f6cadc" />
      <path
        d="M44 49Q47 54 50 49Q53 54 56 49"
        fill="none"
        stroke="#3c8fc5"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M67 62C84 57 87 72 76 72C68 72 71 65 76 67"
        fill="none"
        stroke="#a8d4ef"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <path
        d="M36 63L33 68M60 64L64 68"
        stroke="#a8d4ef"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  ) : (
    <svg
      viewBox="0 0 100 80"
      className={`theme-character ${className}`}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M25 36L14 11L39 22M75 36L86 11L61 22"
        fill="#30223f"
        stroke="#b99ace"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <circle cx="14" cy="10" r="4" fill="#eda2ce" />
      <circle cx="86" cy="10" r="4" fill="#eda2ce" />
      <path
        d="M24 37C20 10 80 10 76 37L73 54C70 68 30 68 27 54Z"
        fill="#30223f"
        stroke="#b99ace"
        strokeWidth="2"
      />
      <path
        d="M29 41C38 45 42 32 50 35C58 32 63 45 71 41L72 52C66 68 34 68 28 52Z"
        fill="#fff4fc"
      />
      <path
        d="M42 26C42 16 58 16 58 26C58 31 54 31 54 34H46C46 31 42 31 42 26Z"
        fill="#ef9cca"
      />
      <ellipse cx="47" cy="25" rx="1.8" ry="2.2" fill="#30223f" />
      <ellipse cx="53" cy="25" rx="1.8" ry="2.2" fill="#30223f" />
      <path d="M49 31H51" stroke="#30223f" strokeWidth="1.8" />
      <path
        d="M34 45L42 46M58 46L66 44"
        stroke="#30223f"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <ellipse cx="39" cy="49" rx="2.5" ry="3.7" fill="#30223f" />
      <ellipse cx="61" cy="49" rx="2.5" ry="3.7" fill="#30223f" />
      <path
        d="M46 56Q51 60 55 54"
        fill="none"
        stroke="#b85891"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <ellipse cx="32" cy="55" rx="4" ry="2.2" fill="#efbbd5" />
      <ellipse cx="68" cy="55" rx="4" ry="2.2" fill="#efbbd5" />
      <path
        d="M36 65L32 70L43 67M64 65L68 70L57 67"
        fill="#30223f"
        stroke="#b99ace"
        strokeWidth="1.5"
      />
    </svg>
  );
}

export function ThemeScene({ name }: { name: ThemeName }) {
  return (
    <div className={`theme-scene-art ${name}`} aria-hidden="true">
      <span className="theme-scene-orbit" />
      <span className="theme-scene-cloud cloud-one" />
      <span className="theme-scene-cloud cloud-two" />
      <span className="theme-scene-spark spark-one">✦</span>
      <span className="theme-scene-spark spark-two">✧</span>
      <ThemeCharacter name={name} />
    </div>
  );
}
