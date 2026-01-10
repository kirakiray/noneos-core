/**
 * 为主题和单个颜色生成颜色数据
 * @returns {Object} 包含主题、颜色、调色板内容和主题样式的对象
 */

import { getColors } from "./mcu-ts/index.js";

export const getColorsData = () => {
  let paletteContent = "";

  // Base color definitions
  const baseColors = [
    { name: "primary", color: "#1a7bd1" },
    { name: "success", color: "#6b9e52" },
    { name: "error", color: "#fb4747" },
    { name: "normal", color: "#808080" },
  ];

  // Generate color palettes for each base color
  const colorPalettes = baseColors.map((baseColor) => {
    const generatedColors = getColors(baseColor.color, points);

    return {
      name: baseColor.name,
      pick: baseColor.color,
      colors: generatedColors.map((color, index) => {
        const cssVar = `--md-ref-palette-${baseColor.name}${points[index]}`;
        paletteContent += `${cssVar}: ${color};\n`;

        return {
          cssVar,
          color,
          point: points[index],
        };
      }),
    };
  });

  // Process themes with their specific color mappings
  const processedThemes = themes.map((theme) => {
    let colorStyleContent = "";

    // Map each base color to theme-specific roles
    const themeGroups = colorPalettes.map((palette) => {
      const themeItem = {
        name: palette.name,
        blocks: [],
      };

      // Process each color role in the theme
      theme.names.forEach((themeName) => {
        const targetColorItem = palette.colors.find(
          (c) => c.point === themeName.num
        );

        const finalCssVar = themeName.cssVar.replace(
          "-main",
          "-" + palette.name
        );

        colorStyleContent += `${finalCssVar}: var(${targetColorItem.cssVar});\n`;

        themeItem.blocks.push({
          name: themeName.name.replace(
            "Main",
            palette.name.charAt(0).toUpperCase() + palette.name.slice(1)
          ),
          cssVar: finalCssVar,
          color: targetColorItem.color,
          point: targetColorItem.point,
        });
      });

      return themeItem;
    });

    // Get surface and on-surface colors from normal palette
    const normalPalette = colorPalettes.find((p) => p.name === "normal");
    const surfaceItem = normalPalette.colors.find(
      (c) => c.point === theme.surface
    );
    const onSurfaceItem = normalPalette.colors.find(
      (c) => c.point === theme.onSurface
    );

    colorStyleContent += `--md-sys-color-surface: var(${surfaceItem.cssVar});\n`;
    colorStyleContent += `--md-sys-color-on-surface: var(${onSurfaceItem.cssVar});\n`;

    return {
      theme: theme.themeName.charAt(0).toUpperCase() + theme.themeName.slice(1),
      groups: themeGroups,
      colorStyleContent,
      surface: {
        cssVar: "--md-sys-color-surface",
        color: surfaceItem.color,
      },
      onSurface: {
        cssVar: "--md-sys-color-on-surface",
        color: onSurfaceItem.color,
      },
    };
  });

  return {
    paletteContent,
    themes: processedThemes,
    colors: colorPalettes,
  };
};

// 主题定义，包含表面和颜色映射
const themes = [
  {
    themeName: "light",
    surface: 98, // 浅色表面颜色点
    onSurface: 10, // 浅色表面前景色点
    names: [
      {
        name: "Main",
        cssVar: "--md-sys-color-main",
        num: 40, // 浅色主题的主要颜色点
        reverseNum: 100, // 对比色点
      },
      {
        name: "On Main",
        cssVar: "--md-sys-color-on-main",
        num: 100, // 浅色主题的主要颜色前景色点
        reverseNum: 40, // 对比色点
      },
      {
        name: "Main Container",
        cssVar: "--md-sys-color-main-container",
        num: 90, // 浅色主题的主要容器颜色点
        reverseNum: 10, // 对比色点
      },
      {
        name: "On Main Container",
        cssVar: "--md-sys-color-on-main-container",
        num: 10, // 浅色主题的主要容器前景色点
        reverseNum: 90, // 对比色点
      },
    ],
  },
  {
    themeName: "dark",
    surface: 6, // 深色表面颜色点
    onSurface: 90, // 深色表面前景色点
    names: [
      {
        name: "Main",
        cssVar: "--md-sys-color-main",
        num: 80, // 深色主题的主要颜色点
        reverseNum: 20, // 对比色点
      },
      {
        name: "On Main",
        cssVar: "--md-sys-color-on-main",
        num: 20, // 深色主题的主要颜色前景色点
        reverseNum: 80, // 对比色点
      },
      {
        name: "Main Container",
        cssVar: "--md-sys-color-main-container",
        num: 30, // 深色主题的主要容器颜色点
        reverseNum: 70, // 对比色点
      },
      {
        name: "On Main Container",
        cssVar: "--md-sys-color-on-main-container",
        num: 90, // 深色主题的主要容器前景色点
        reverseNum: 70, // 对比色点
      },
    ],
  },
];

// 用于生成颜色调色板的色调点（0-100 比例）
const points = [100, 98, 95, 90, 80, 70, 60, 50, 40, 30, 20, 10, 6, 0];
