import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SkillEntry {
  name: string;
  path: string;
}

interface Props {
  /** The query text after / (e.g. "code-rev" from "/code-rev") */
  query: string;
  /** Root path to list skills from */
  rootPath: string;
  /** Called when a skill is selected */
  onSelect: (skillPath: string, skillName: string) => void;
  /** Called when the autocomplete should close */
  onClose: () => void;
  /** Optional additional class name */
  className?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function SkillAutocomplete({ query, rootPath, onSelect, onClose, className }: Props) {
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // ----- Load skills from .skills/ directory -----
  useEffect(() => {
    if (!rootPath) return;
    setLoading(true);
    invoke<SkillEntry[]>("list_skills", { rootPath })
      .then((entries) => {
        setSkills(entries);
      })
      .catch(() => setSkills([]))
      .finally(() => setLoading(false));
  }, [rootPath]);

  // ----- Filter skills by query -----
  const filteredSkills = (() => {
    if (!query) return skills;
    const lowerQuery = query.toLowerCase();
    return skills.filter((s) => s.name.toLowerCase().includes(lowerQuery));
  })();

  // ----- Clamp selected index -----
  useEffect(() => {
    if (selectedIndex >= filteredSkills.length) {
      setSelectedIndex(Math.max(0, filteredSkills.length - 1));
    }
  }, [filteredSkills.length, selectedIndex]);

  // ----- Scroll selected item into view -----
  useEffect(() => {
    const container = listRef.current;
    if (!container) return;
    const items = container.querySelectorAll<HTMLElement>(".skill-autocomplete-item");
    const target = items[selectedIndex];
    target?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  // ----- Keyboard handling -----
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filteredSkills.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const selected = filteredSkills[selectedIndex];
        if (!selected) return;
        onSelect(selected.path, selected.name);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [filteredSkills, selectedIndex, onSelect, onClose],
  );

  // Listen for keyboard events on the panel
  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // ----- Render -----
  if (filteredSkills.length === 0 && !loading) return null;

  return (
    <div className={`skill-autocomplete ${className || ""}`} ref={listRef}>
      {loading && <div className="skill-autocomplete-loading">Loading...</div>}

      {filteredSkills.map((skill, i) => (
        <div
          key={skill.path}
          className={`skill-autocomplete-item ${i === selectedIndex ? "selected" : ""}`}
          onMouseDown={() => onSelect(skill.path, skill.name)}
          onMouseEnter={() => setSelectedIndex(i)}
        >
          <span className="skill-autocomplete-icon">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
            </svg>
          </span>
          <span className="skill-autocomplete-name">{skill.name}</span>
          <span className="skill-autocomplete-path">.skills/{skill.name}.md</span>
        </div>
      ))}
    </div>
  );
}
