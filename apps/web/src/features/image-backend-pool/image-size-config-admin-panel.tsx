"use client";

import type {
  ImageSizeConfigInput,
  ImageSizeConfigMapping,
} from "@repo/shared/image-backend/image-size-config";
import type { ImageSizeConfigOutput } from "@repo/shared/uol/operations/image-backend-pool";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import { Plus, Trash2 } from "lucide-react";
import { useAction } from "next-safe-action/hooks";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import {
  deleteImageSizeConfigAction,
  listImageSizeConfigsAction,
  saveImageSizeConfigAction,
} from "./actions";

type EditableMapping = ImageSizeConfigMapping & { key: string };
type Config = Omit<ImageSizeConfigInput, "mappings"> & {
  mappings: EditableMapping[];
};
let nextMappingKey = 0;
const emptyMapping = (): EditableMapping => ({
  resolution: "1k",
  aspectRatio: "1:1",
  size: "1024x1024",
  key: `mapping-${nextMappingKey++}`,
});

export function ImageSizeConfigAdminPanel({
  readOnly = false,
}: {
  readOnly?: boolean;
}) {
  const [configs, setConfigs] = useState<ImageSizeConfigOutput[]>([]);
  const [editing, setEditing] = useState<Config>({
    name: "",
    mappings: [emptyMapping()],
  });
  const { execute: load } = useAction(listImageSizeConfigsAction, {
    onSuccess: ({ data }) => setConfigs(data?.configs ?? []),
  });
  const { execute: save, isPending: saving } = useAction(
    saveImageSizeConfigAction,
    {
      onSuccess: () => {
        toast.success("尺寸配置已保存");
        setEditing({ name: "", mappings: [emptyMapping()] });
        load();
      },
      onError: ({ error }) =>
        toast.error(error.serverError || "保存尺寸配置失败"),
    }
  );
  const { execute: remove } = useAction(deleteImageSizeConfigAction, {
    onSuccess: () => {
      toast.success("尺寸配置已删除");
      load();
    },
    onError: ({ error }) =>
      toast.error(error.serverError || "删除尺寸配置失败"),
  });
  useEffect(() => {
    load();
  }, [load]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!editing.name.trim() || editing.mappings.length === 0) return;
    save({
      ...(editing.id ? { id: editing.id } : {}),
      name: editing.name,
      mappings: editing.mappings.map(({ key: _key, ...mapping }) => mapping),
    });
  }

  return (
    <div className="space-y-6">
      <form className="space-y-4 rounded-lg border p-4" onSubmit={submit}>
        <div className="space-y-2">
          <Label htmlFor="size-config-name">配置名称</Label>
          <Input
            id="size-config-name"
            value={editing.name}
            disabled={readOnly}
            onChange={(event) =>
              setEditing({ ...editing, name: event.target.value })
            }
          />
        </div>
        <div className="space-y-2">
          <Label>分辨率 + 比例映射</Label>
          {editing.mappings.map((mapping, index) => (
            <div
              className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]"
              key={mapping.key}
            >
              <Input
                placeholder="resolution"
                value={mapping.resolution}
                disabled={readOnly}
                onChange={(event) =>
                  setEditing({
                    ...editing,
                    mappings: editing.mappings.map((item, i) =>
                      i === index
                        ? { ...item, resolution: event.target.value }
                        : item
                    ),
                  })
                }
              />
              <Input
                placeholder="aspectRatio"
                value={mapping.aspectRatio}
                disabled={readOnly}
                onChange={(event) =>
                  setEditing({
                    ...editing,
                    mappings: editing.mappings.map((item, i) =>
                      i === index
                        ? { ...item, aspectRatio: event.target.value }
                        : item
                    ),
                  })
                }
              />
              <Input
                placeholder="size"
                value={mapping.size}
                disabled={readOnly}
                onChange={(event) =>
                  setEditing({
                    ...editing,
                    mappings: editing.mappings.map((item, i) =>
                      i === index ? { ...item, size: event.target.value } : item
                    ),
                  })
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={readOnly || editing.mappings.length === 1}
                onClick={() =>
                  setEditing({
                    ...editing,
                    mappings: editing.mappings.filter((_, i) => i !== index),
                  })
                }
                aria-label="删除映射"
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={readOnly}
            onClick={() =>
              setEditing({
                ...editing,
                mappings: [...editing.mappings, emptyMapping()],
              })
            }
          >
            <Plus className="size-4" />
            新增映射
          </Button>
        </div>
        {!readOnly && (
          <Button type="submit" disabled={saving}>
            保存配置
          </Button>
        )}
      </form>
      <div className="space-y-2">
        {configs.map((config) => (
          <div
            className="flex items-center justify-between rounded-md border p-3"
            key={config.id}
          >
            <div>
              <div className="font-medium">{config.name}</div>
              <div className="text-xs text-muted-foreground">
                {config.mappings.length} 条映射
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setEditing({
                    id: config.id,
                    name: config.name,
                    mappings: config.mappings.map((mapping) => ({
                      ...mapping,
                      key: `mapping-${nextMappingKey++}`,
                    })),
                  })
                }
              >
                编辑
              </Button>
              {!readOnly && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => remove({ id: config.id })}
                  aria-label="删除配置"
                >
                  <Trash2 className="size-4" />
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
