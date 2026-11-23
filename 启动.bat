@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 课堂同传服务
node start.mjs
pause
