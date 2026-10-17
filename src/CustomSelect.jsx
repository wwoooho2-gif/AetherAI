import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

export default function CustomSelect({
  id,
  value,
  options,
  onChange,
  className = "",
  disabled = false,
  ariaLabel,
  listbox = false,
}) {
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const optionRefs = useRef([]);
  const [open, setOpen] = useState(false);
  const [openUp, setOpenUp] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const selectedIndex = Math.max(0, options.findIndex((option) => String(option.value) === String(value)));
  const selectedOption = options[selectedIndex];

  useEffect(() => {
    if (open && !listbox) {
      optionRefs.current[activeIndex]?.focus();
    } else if (listbox) {
      optionRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex, listbox, open]);

  useEffect(() => {
    if (!open || listbox) return undefined;
    function closeOnOutsidePointer(event) {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [listbox, open]);

  function openMenu(index = selectedIndex) {
    const rect = triggerRef.current?.getBoundingClientRect();
    const menuHeight = Math.min(options.length * 36 + 8, 240);
    setOpenUp(Boolean(rect && window.innerHeight - rect.bottom < menuHeight + 12 && rect.top > menuHeight));
    setActiveIndex(index);
    setOpen(true);
  }

  function chooseOption(option) {
    if (disabled || option.disabled) return;
    onChange(option.value);
    if (!listbox) {
      setOpen(false);
      triggerRef.current?.focus();
    }
  }

  function handleListKeyDown(event) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) => (current + direction + options.length) % options.length);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setActiveIndex(event.key === "Home" ? 0 : options.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (options[activeIndex]) chooseOption(options[activeIndex]);
    } else if (event.key === "Escape" && !listbox) {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (event.key === "Tab" && !listbox) {
      setOpen(false);
    }
  }

  const optionList = (
    <div
      id={listbox ? id : `${id}-listbox`}
      className={`custom-select-menu${listbox ? " custom-select-listbox" : ""}`}
      role="listbox"
      aria-label={ariaLabel}
      aria-disabled={disabled}
      aria-activedescendant={options[activeIndex] ? `${id}-option-${activeIndex}` : undefined}
      onKeyDown={handleListKeyDown}
      tabIndex={listbox && !disabled ? 0 : -1}
    >
      {options.map((option, index) => (
        <div
          key={String(option.value)}
          id={`${id}-option-${index}`}
          ref={(element) => { optionRefs.current[index] = element; }}
          className={`custom-select-option${index === selectedIndex ? " custom-select-option-selected" : ""}${index === activeIndex ? " custom-select-option-active" : ""}`}
          role="option"
          aria-selected={index === selectedIndex}
          tabIndex={-1}
          aria-disabled={disabled || option.disabled}
          onClick={() => chooseOption(option)}
        >
          <span>{option.label}</span>
          {index === selectedIndex && <Check size={13} aria-hidden="true" />}
        </div>
      ))}
    </div>
  );

  if (listbox) {
    return (
      <div ref={rootRef} className={`custom-select custom-select-persistent ${className}`.trim()}>
        {optionList}
      </div>
    );
  }

  return (
    <div ref={rootRef} className={`custom-select${open ? " custom-select-open" : ""} ${className}`.trim()}>
      <button
        id={id}
        ref={triggerRef}
        type="button"
        className="custom-select-trigger"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-listbox`}
        disabled={disabled}
        onClick={() => open ? setOpen(false) : openMenu()}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            openMenu(event.key === "ArrowDown" ? selectedIndex : Math.max(0, selectedIndex - 1));
          }
        }}
      >
        <span>{selectedOption?.label ?? ""}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && <div className={`custom-select-popup${openUp ? " custom-select-popup-up" : ""}`}>{optionList}</div>}
    </div>
  );
}
