import {
  Button,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  Select,
  SelectValue,
  Switch,
} from 'react-aria-components';
import { ChevronDown } from 'lucide-react';

export function ChoiceSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<readonly [string, string]>;
  onChange: (value: string) => void;
}) {
  return (
    <Select className="fl-select" aria-label={label} selectedKey={value} onSelectionChange={(key) => onChange(String(key))}>
      <Label>{label}</Label>
      <Button><SelectValue /><ChevronDown aria-hidden="true" size={15} /></Button>
      <Popover className="fl-popover">
        <ListBox>{options.map(([key, text]) => <ListBoxItem key={key} id={key}>{text}</ListBoxItem>)}</ListBox>
      </Popover>
    </Select>
  );
}

export function SettingSwitch({
  title,
  description,
  isSelected,
  onChange,
}: {
  title: string;
  description: string;
  isSelected: boolean;
  onChange: (selected: boolean) => void;
}) {
  return (
    <Switch className="fl-switch" isSelected={isSelected} onChange={onChange}>
      <span><strong>{title}</strong><small>{description}</small></span>
      <span className="fl-switch-track" />
    </Switch>
  );
}
