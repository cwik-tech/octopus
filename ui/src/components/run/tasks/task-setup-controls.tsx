import WorkflowPicker from "@/components/run/pickers/workflow-picker";
import { SidebarSectionHeader } from "@/components/sidebar/sidebar-section-header";

interface TaskSetupControlsProps {
  selectedWorkflow: string | null;
  onSelectWorkflow: (id: string) => void;
}

function TaskSetupControls({
  selectedWorkflow,
  onSelectWorkflow,
}: TaskSetupControlsProps) {
  return (
    <section className="min-h-0 flex-1">
      <SidebarSectionHeader title="Workflow Templates" />
      <WorkflowPicker
        selectedWorkflow={selectedWorkflow}
        onSelectWorkflow={onSelectWorkflow}
      />
    </section>
  );
}

export default TaskSetupControls;
